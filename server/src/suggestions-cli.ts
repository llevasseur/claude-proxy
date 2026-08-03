/**
 * Session suggestion flags from the command line — the interface an agent uses to
 * find what is still worth doing and to record that it did it. Reads the log
 * directory directly, so it works with no server running.
 *
 *   pnpm --filter server suggestions list                       # every bucket
 *   pnpm --filter server suggestions list -r 2-9                # buckets 2 through 9
 *   pnpm --filter server suggestions list -r 2,3,9 -s pending   # only what's pending
 *   pnpm --filter server suggestions list -r 9 --json           # machine-readable
 *   pnpm --filter server suggestions list -r 9 -s pending -d    # with evidence + sources
 *   pnpm --filter server suggestions list --recurrence historical  # the windows a fix predates
 *   pnpm --filter server suggestions mark -r 9 -i serial-discovery -s done -n "PR #71"
 *   pnpm --filter server suggestions mark -r 9 -i redundant-reads,high-tool-churn -s done
 *
 * `list` prints one row per suggestion: bucket, flag, severity, id, title, plus the
 * detail/evidence/sources under `--detail`. `mark` writes flags for one or more ids
 * in one bucket. `--json` on either prints the API's own response, which is the
 * shape callers should parse.
 *
 * **`list` hides `historical` rows by default** — windows a rule's `done` postdates,
 * with nothing left to act on. They are counted in the header and reachable with
 * `--recurrence`.
 */
import {
  countSuggestionRecurrences,
  countSuggestionStatuses,
  isSuggestionRecurrence,
  isSuggestionStatus,
  parseBucketRange,
  SUGGESTION_RECURRENCES,
  type SuggestionRecurrence,
  type SuggestionStatus,
  type SuggestionStatusRow,
} from '@claude-proxy/core';
import { applySuggestionStatus, buildSuggestionStatus, type SuggestionStatusResponse } from './api.js';
import { resolveLogDir } from './logs.js';

const USAGE = `usage:
  suggestions list [-r|--range <spec>] [-s|--status <flags>] [--recurrence <states>] [-d|--detail] [--json]
  suggestions mark  -r|--range <bucket> -i|--id <ids> -s|--status <flag> [-n|--note <text>] [--json]

  <spec>   one bucket (9), a list (2,3,9), a span (2-9), or a mix (2-4,9)
  <flags>  comma-separated: pending, done, skipped
  <states> comma-separated: none, historical, mixed, regressed
           defaults to everything but historical — windows whose sessions all
           predate the rule's own 'done' can no longer be acted on
  <ids>    comma-separated suggestion ids, as printed by list`;

/** What `list` shows without `--recurrence`: every state but the frozen `historical` windows. */
const ACTIONABLE_RECURRENCES: readonly SuggestionRecurrence[] = SUGGESTION_RECURRENCES.filter(
  (r) => r !== 'historical',
);

/** Flags that stand alone; every other flag takes the next argv entry as its value. */
const BOOLEAN_FLAGS = new Set(['json', 'detail']);

/** Read `--flag value` / `-f value` pairs off argv; anything else is a positional. */
function parseArgs(argv: readonly string[]): {
  positionals: string[];
  flags: Record<string, string>;
  json: boolean;
  detail: boolean;
} {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const switches = new Set<string>();

  const NAMES: Record<string, string> = { r: 'range', s: 'status', i: 'id', n: 'note', d: 'detail' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const match = /^--?([A-Za-z-]+)$/.exec(arg);
    if (!match?.[1]) {
      positionals.push(arg);
      continue;
    }
    const name = NAMES[match[1]] ?? match[1];
    if (BOOLEAN_FLAGS.has(name)) {
      switches.add(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${name}`);
    flags[name] = value;
  }
  return { positionals, flags, json: switches.has('json'), detail: switches.has('detail') };
}

function parseStatuses(raw: string): SuggestionStatus[] {
  return raw.split(',').map((part) => {
    const status = part.trim();
    if (!isSuggestionStatus(status)) throw new Error(`invalid status: ${status}`);
    return status;
  });
}

function parseRecurrences(raw: string): SuggestionRecurrence[] {
  return raw.split(',').map((part) => {
    const recurrence = part.trim();
    if (!isSuggestionRecurrence(recurrence)) throw new Error(`invalid recurrence: ${recurrence}`);
    return recurrence;
  });
}

/** The recurrence marker on a row — blank for `none`, loud for `regressed`. */
function renderRecurrence(row: SuggestionStatusRow): string {
  if (row.recurrence === 'none') return '';
  const since = row.resolved ? ` since ${row.resolved.updated.slice(0, 10)}` : '';
  if (row.recurrence === 'regressed') return `  ⚠ REGRESSED${since}`;
  if (row.recurrence === 'historical') return `  (pre-fix window${since})`;
  return `  (spans the fix${since})`;
}

function renderRows(rows: readonly SuggestionStatusRow[]): string {
  if (rows.length === 0) return 'no suggestions match.';
  const width = Math.max(...rows.map((r) => r.id.length));
  return rows
    .map((r) => {
      const note = r.note ? `  — ${r.note}` : '';
      const head = `  ${String(r.bucket).padStart(3)} ${r.label.padEnd(9)} ${r.status.padEnd(7)} ${r.severity.padEnd(4)} ${r.id.padEnd(width)}  ${r.title}${renderRecurrence(r)}${note}`;
      if (!r.detail) return head;
      const sources = (r.sources ?? []).map((s) => `        · ${s.label}${s.sample ? `: ${s.sample}` : ''}`);
      return [head, `      ${r.detail}`, `      evidence: ${r.evidence}`, ...sources].join('\n');
    })
    .join('\n');
}

async function run(argv: readonly string[]): Promise<void> {
  const { positionals, flags, json, detail } = parseArgs(argv);
  const command = positionals[0] ?? 'list';
  const logDir = resolveLogDir();

  if (command === 'list') {
    const wanted = new Set(flags.recurrence ? parseRecurrences(flags.recurrence) : ACTIONABLE_RECURRENCES);
    // Read every recurrence state, then narrow here, so the rows left out can be counted.
    const full = await buildSuggestionStatus(logDir, {
      buckets: flags.range ? parseBucketRange(flags.range) : undefined,
      statuses: flags.status ? parseStatuses(flags.status) : undefined,
      detail,
    });
    const rows = full.rows.filter((row) => wanted.has(row.recurrence));
    const hidden = full.rows.length - rows.length;
    // Split the hidden count: frozen windows get their own line, the rest were just not asked for.
    const hiddenHistorical = wanted.has('historical') ? 0 : countSuggestionRecurrences(full.rows).historical;
    const result: SuggestionStatusResponse = {
      rows,
      meta: { ...full.meta, counts: countSuggestionStatuses(rows), recurrences: countSuggestionRecurrences(rows) },
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { counts, recurrences, buckets, missing } = result.meta;
    const range = buckets.length ? `buckets 1–${buckets[buckets.length - 1]} exist` : 'no buckets yet';
    console.log(
      `${range} · ${rows.length} suggestion(s) shown: ${counts.pending} pending, ${counts.done} done, ${counts.skipped} skipped`,
    );
    if (recurrences.regressed > 0) {
      console.log(`⚠ ${recurrences.regressed} regressed — marked done, still tripping in windows recorded since.`);
    }
    if (hiddenHistorical > 0) {
      console.log(
        `(${hiddenHistorical} hidden: their window predates the rule's own 'done' — see --recurrence historical)`,
      );
    }
    if (hidden - hiddenHistorical > 0) {
      console.log(`(${hidden - hiddenHistorical} more outside --recurrence ${[...wanted].join(',')})`);
    }
    if (missing.length) console.log(`(no such bucket: ${missing.join(', ')})`);
    console.log(renderRows(rows));
    return;
  }

  if (command === 'mark') {
    if (!flags.range) throw new Error('mark needs --range <bucket>');
    if (!flags.id) throw new Error('mark needs --id <ids>');
    if (!flags.status) throw new Error('mark needs --status <flag>');
    const buckets = parseBucketRange(flags.range);
    const [bucket] = buckets;
    if (buckets.length !== 1 || bucket === undefined) {
      throw new Error('mark takes one bucket at a time — a suggestion id belongs to a bucket');
    }
    const [status] = parseStatuses(flags.status);
    if (!status) throw new Error('mark needs --status <flag>');
    const ids = flags.id
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) throw new Error('mark needs at least one id');

    const result = await applySuggestionStatus(
      logDir,
      ids.map((id) => ({ bucket, id, status, ...(flags.note === undefined ? {} : { note: flags.note }) })),
    );
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`marked ${result.meta.updated} suggestion(s) in ${result.meta.statusFile}`);
    if (result.meta.unknown.length) {
      console.log(
        `(no suggestion currently carries: ${result.meta.unknown.map((u) => `${u.bucket}/${u.id}`).join(', ')} — flag written anyway)`,
      );
    }
    console.log(renderRows(result.rows));
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
}

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`[suggestions] ${(err as Error).message}`);
  process.exitCode = 1;
});
