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
 *   pnpm --filter server suggestions buckets --dirty            # complete, unjudged
 *   pnpm --filter server suggestions judge -r 38 \
 *     --confirm "redundant-reads:re-read api.ts 4× while hunting one symbol" \
 *     --dismiss "serial-discovery:each read gated the next path"
 *   pnpm --filter server suggestions judge --amnesty            # draw a line under the backlog
 *   pnpm --filter server suggestions defects                    # rules dismissed too often
 *
 * `list` prints one row per suggestion: bucket, flag, severity, id, title, plus the
 * detail/evidence/sources under `--detail`. `mark` writes flags for one or more ids
 * in one bucket. `--json` on either prints the API's own response, which is the
 * shape callers should parse.
 *
 * **`list` hides `historical` rows by default** — windows a rule's `done` postdates,
 * with nothing left to act on. They are counted in the header and reachable with
 * `--recurrence`.
 *
 * The judgement half is the adjudication an agent does *before* `/improve` acts:
 * `buckets` finds the complete windows with no verdict, `judge` records one — a
 * `--dismiss` is an ordinary `dismissed` flag with the reason in its note, a
 * `--confirm` leaves the suggestion pending and files the judge's context at bucket
 * level where marking it `done` cannot clobber it — and `defects` reports the rules
 * whose dismissals have piled up enough to indict the rule itself.
 */
import {
  type BucketJudgementRow,
  countSuggestionRecurrences,
  countSuggestionStatuses,
  isSuggestionRecurrence,
  isSuggestionStatus,
  isThreadId,
  parseBucketRange,
  parseCliArgs,
  parseJudgeEntries,
  type RuleDefect,
  SUGGESTION_RECURRENCES,
  type SuggestionJudgementWrite,
  type SuggestionRecurrence,
  type SuggestionStatus,
  type SuggestionStatusRow,
  type SuggestionStatusUpdate,
} from '@claude-proxy/core';
import {
  applySuggestionJudge,
  applySuggestionStatus,
  buildRuleDefects,
  buildSuggestionBuckets,
  buildSuggestionStatus,
  type SuggestionStatusResponse,
} from './api.js';
import { resolveLogDir } from './logs.js';

const USAGE = `usage:
  suggestions list    [-r|--range <spec>] [-s|--status <flags>] [--recurrence <states>] [-d|--detail] [--json]
  suggestions mark     -r|--range <bucket> -i|--id <ids> -s|--status <flag> [-n|--note <text>] [--json]
  suggestions buckets [--dirty] [--json]
  suggestions judge    -r|--range <bucket> [--confirm <id>[:<note>],...] [--dismiss <id>:<reason>,...] [--thread <id>] [--json]
  suggestions judge   --amnesty [--thread <id>] [--json]
  suggestions defects [--json]

  <spec>   one bucket (9), a list (2,3,9), a span (2-9), or a mix (2-4,9)
  <flags>  comma-separated: pending, done, skipped, dismissed
  <states> comma-separated: none, historical, mixed, regressed
           defaults to everything but historical — windows whose sessions all
           predate the rule's own 'done' can no longer be acted on
  <ids>    comma-separated suggestion ids, as printed by list

  judge --confirm keeps the suggestion pending and files the note at bucket level;
  judge --dismiss writes a 'dismissed' flag with the reason in its note — the rule
  was wrong here, which is a different claim from 'skipped'. Only complete buckets
  can be judged. --amnesty marks every complete, still-unjudged bucket judged with
  no notes, leaving buckets already judged (and their notes) untouched.

  judge --thread <id> records the judging session's own thread id on the verdict,
  and with it how many of the window's transcripts that thread opened — counted
  off its own transcript, not self-reported. buckets marks a verdict 'thin' when
  the share is under 30%. Advisory: it is never a reason a write is refused.`;

/** What `list` shows without `--recurrence`: every state but the frozen `historical` windows. */
const ACTIONABLE_RECURRENCES: readonly SuggestionRecurrence[] = SUGGESTION_RECURRENCES.filter(
  (r) => r !== 'historical',
);

/** How this CLI spells its own flags; `--help`/`-h` are the parser's, not ours. */
const ARGS_SPEC = {
  aliases: { r: 'range', s: 'status', i: 'id', n: 'note', d: 'detail', t: 'thread' },
  booleans: ['json', 'detail', 'dirty', 'amnesty'],
  // Accumulating flags, so repeating one is the escape hatch for a note whose
  // commas would otherwise read as separators.
  lists: ['confirm', 'dismiss'],
} as const;

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
      // The judge's context is the reason a confirmed suggestion is worth acting on,
      // so it belongs on the row even when the row carries no flag of its own.
      const enrichment = r.enrichment ? `\n      judged: ${r.enrichment}` : '';
      const head = `  ${String(r.bucket).padStart(3)} ${r.label.padEnd(9)} ${r.status.padEnd(9)} ${r.severity.padEnd(4)} ${r.id.padEnd(width)}  ${r.title}${renderRecurrence(r)}${note}${enrichment}`;
      if (!r.detail) return head;
      const sources = (r.sources ?? []).map((s) => `        · ${s.label}${s.sample ? `: ${s.sample}` : ''}`);
      return [head, `      ${r.detail}`, `      evidence: ${r.evidence}`, ...sources].join('\n');
    })
    .join('\n');
}

/** Buckets one per line: index, span, state, who judged it, and when. */
function renderBuckets(rows: readonly BucketJudgementRow[]): string {
  if (rows.length === 0) return 'no buckets match.';
  return rows
    .map((b) => {
      // Attribution rides on the `judged` word rather than taking its own column:
      // most rows have none, and an empty column on every line reads as a defect.
      const who = b.by ? ` by ${b.by.thread}${b.by.window ? ` (${b.by.opened}/${b.by.window} read)` : ''}` : '';
      const thin = b.thin ? ' THIN' : '';
      const when = b.judgedAt ? ` judged ${b.judgedAt.slice(0, 10)}${who}${thin}` : who;
      const notes = b.notes ? ` · ${b.notes} note${b.notes === 1 ? '' : 's'}` : '';
      const short = b.complete ? '' : ' (not yet full)';
      return `  ${String(b.bucket).padStart(3)} ${b.label.padEnd(9)} ${b.state.padEnd(9)} ${b.suggestions} suggestion${b.suggestions === 1 ? '' : 's'}${when}${notes}${short}`;
    })
    .join('\n');
}

/** One defect per rule, with the buckets and reasons underneath it. */
function renderDefects(defects: readonly RuleDefect[]): string {
  if (defects.length === 0) return 'no rule has been dismissed often enough to indict it.';
  return defects
    .map((d) => {
      const head = `  ${d.id} — dismissed in ${d.dismissed} of ${d.fired} bucket${d.fired === 1 ? '' : 's'} it fired in (${Math.round(d.ratio * 100)}%)`;
      const lines = d.buckets.map((b) => `      · bucket ${b.bucket}${b.reason ? `: ${b.reason}` : ''}`);
      return [head, ...lines].join('\n');
    })
    .join('\n');
}

async function run(argv: readonly string[]): Promise<void> {
  const { positionals, flags, lists, switches, help } = parseCliArgs(argv, ARGS_SPEC);
  // Before any subcommand dispatch, so `judge --help` answers the same as `--help`.
  if (help) {
    console.log(USAGE);
    return;
  }
  const json = switches.has('json');
  const detail = switches.has('detail');
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
    const { counts, recurrences, buckets, missing, bucketStates } = result.meta;
    const range = buckets.length ? `buckets 1–${buckets[buckets.length - 1]} exist` : 'no buckets yet';
    console.log(
      `${range} · ${rows.length} suggestion(s) shown: ${counts.pending} pending, ${counts.done} done, ${counts.skipped} skipped, ${counts.dismissed} dismissed`,
    );
    if (bucketStates.dirty > 0) {
      console.log(`(${bucketStates.dirty} complete bucket(s) unjudged — see 'suggestions buckets --dirty')`);
    }
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

  if (command === 'buckets') {
    const result = await buildSuggestionBuckets(logDir, { dirty: switches.has('dirty') });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { states } = result.meta;
    console.log(
      `${result.buckets.length} bucket(s) shown · ${states.dirty} dirty, ${states.clean} clean, ${states['not-ready']} not ready`,
    );
    console.log(renderBuckets(result.buckets));
    return;
  }

  if (command === 'judge') {
    const amnesty = switches.has('amnesty');
    const confirms = parseJudgeEntries(lists.confirm ?? []);
    const dismissals = parseJudgeEntries(lists.dismiss ?? []);
    for (const entry of dismissals) {
      if (!entry.note) throw new Error(`--dismiss ${entry.id} needs a reason: --dismiss "${entry.id}:<why>"`);
    }

    let judged: SuggestionJudgementWrite[] = [];
    let updates: SuggestionStatusUpdate[] = [];
    if (!amnesty) {
      if (!flags.range) throw new Error('judge needs --range <bucket>, or --amnesty');
      const buckets = parseBucketRange(flags.range);
      const [bucket] = buckets;
      if (buckets.length !== 1 || bucket === undefined) {
        throw new Error('judge takes one bucket at a time — a verdict is about one window');
      }
      // A confirmation is not a status write: the suggestion stays pending, and its
      // context goes to the bucket where marking it `done` cannot overwrite it.
      const notes = Object.fromEntries(confirms.filter((c) => c.note).map((c) => [c.id, c.note]));
      judged = [{ bucket, notes }];
      updates = dismissals.map((d) => ({ bucket, id: d.id, status: 'dismissed' as const, note: d.note }));
    } else if (confirms.length > 0 || dismissals.length > 0) {
      throw new Error('--amnesty records no notes and no dismissals — drop --confirm/--dismiss, or drop --amnesty');
    }

    if (flags.thread !== undefined && !isThreadId(flags.thread)) {
      throw new Error(`--thread ${flags.thread} is not a 16-hex-character thread id`);
    }
    const result = await applySuggestionJudge(logDir, {
      updates,
      judged,
      amnesty,
      ...(flags.thread === undefined ? {} : { thread: flags.thread }),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `judged ${result.meta.judged} bucket(s), wrote ${result.meta.updated} flag(s) in ${result.meta.statusFile}`,
    );
    if (result.meta.unknown.length) {
      console.log(
        `(no suggestion currently carries: ${result.meta.unknown.map((u) => `${u.bucket}/${u.id}`).join(', ')} — flag written anyway)`,
      );
    }
    const { states } = result.meta;
    console.log(`${states.dirty} dirty, ${states.clean} clean, ${states['not-ready']} not ready`);
    if (!amnesty) console.log(renderRows(result.rows));
    return;
  }

  if (command === 'defects') {
    const result = await buildRuleDefects(logDir);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { minDismissedBuckets, minDismissedRatio } = result.meta.thresholds;
    console.log(
      `${result.defects.length} defective rule(s) over ${result.meta.buckets} complete bucket(s) · threshold: ${minDismissedBuckets}+ dismissals and ${Math.round(minDismissedRatio * 100)}%+ of the buckets it fired in`,
    );
    console.log(renderDefects(result.defects));
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
}

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`[suggestions] ${(err as Error).message}`);
  process.exitCode = 1;
});
