/**
 * Session suggestion flags from the command line — the interface an agent uses to
 * find what is still worth doing and to record that it did it. Reads the log
 * directory directly, so it works with no server running.
 *
 *   pnpm --filter server suggestions list                       # every bucket
 *   pnpm --filter server suggestions list -r 2-9                # buckets 2 through 9
 *   pnpm --filter server suggestions list -r 2,3,9 -s pending   # only what's pending
 *   pnpm --filter server suggestions list -r 9 --json           # machine-readable
 *   pnpm --filter server suggestions mark -r 9 -i serial-discovery -s done -n "PR #71"
 *   pnpm --filter server suggestions mark -r 9 -i redundant-reads,high-tool-churn -s done
 *
 * `list` prints one row per suggestion: bucket, flag, severity, id, title. `mark`
 * writes flags for one or more ids in one bucket. `--json` on either prints the
 * API's own response, which is the shape callers should parse.
 */
import { isSuggestionStatus, parseBucketRange, type SuggestionStatus, type SuggestionStatusRow } from "@claude-proxy/core";
import { applySuggestionStatus, buildSuggestionStatus } from "./api.js";
import { resolveLogDir } from "./logs.js";

const USAGE = `usage:
  suggestions list [-r|--range <spec>] [-s|--status <flags>] [--json]
  suggestions mark  -r|--range <bucket> -i|--id <ids> -s|--status <flag> [-n|--note <text>] [--json]

  <spec>  one bucket (9), a list (2,3,9), a span (2-9), or a mix (2-4,9)
  <flags> comma-separated: pending, done, skipped
  <ids>   comma-separated suggestion ids, as printed by list`;

/** Read `--flag value` / `-f value` pairs off argv; anything else is a positional. */
function parseArgs(argv: readonly string[]): { positionals: string[]; flags: Record<string, string>; json: boolean } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;

  const NAMES: Record<string, string> = { r: "range", s: "status", i: "id", n: "note" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--json") {
      json = true;
      continue;
    }
    const match = /^--?([A-Za-z-]+)$/.exec(arg);
    if (!match?.[1]) {
      positionals.push(arg);
      continue;
    }
    const name = NAMES[match[1]] ?? match[1];
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${name}`);
    flags[name] = value;
  }
  return { positionals, flags, json };
}

function parseStatuses(raw: string): SuggestionStatus[] {
  return raw.split(",").map((part) => {
    const status = part.trim();
    if (!isSuggestionStatus(status)) throw new Error(`invalid status: ${status}`);
    return status;
  });
}

function renderRows(rows: readonly SuggestionStatusRow[]): string {
  if (rows.length === 0) return "no suggestions match.";
  const width = Math.max(...rows.map((r) => r.id.length));
  return rows
    .map((r) => {
      const note = r.note ? `  — ${r.note}` : "";
      return `  ${String(r.bucket).padStart(3)} ${r.label.padEnd(9)} ${r.status.padEnd(7)} ${r.severity.padEnd(4)} ${r.id.padEnd(width)}  ${r.title}${note}`;
    })
    .join("\n");
}

async function run(argv: readonly string[]): Promise<void> {
  const { positionals, flags, json } = parseArgs(argv);
  const command = positionals[0] ?? "list";
  const logDir = resolveLogDir();

  if (command === "list") {
    const result = await buildSuggestionStatus(logDir, {
      buckets: flags.range ? parseBucketRange(flags.range) : undefined,
      statuses: flags.status ? parseStatuses(flags.status) : undefined,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { counts, buckets, missing } = result.meta;
    const range = buckets.length ? `buckets 1–${buckets[buckets.length - 1]} exist` : "no buckets yet";
    console.log(`${range} · ${result.rows.length} suggestion(s) shown: ${counts.pending} pending, ${counts.done} done, ${counts.skipped} skipped`);
    if (missing.length) console.log(`(no such bucket: ${missing.join(", ")})`);
    console.log(renderRows(result.rows));
    return;
  }

  if (command === "mark") {
    if (!flags.range) throw new Error("mark needs --range <bucket>");
    if (!flags.id) throw new Error("mark needs --id <ids>");
    if (!flags.status) throw new Error("mark needs --status <flag>");
    const buckets = parseBucketRange(flags.range);
    const [bucket] = buckets;
    if (buckets.length !== 1 || bucket === undefined) {
      throw new Error("mark takes one bucket at a time — a suggestion id belongs to a bucket");
    }
    const [status] = parseStatuses(flags.status);
    if (!status) throw new Error("mark needs --status <flag>");
    const ids = flags.id
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) throw new Error("mark needs at least one id");

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
      console.log(`(no suggestion currently carries: ${result.meta.unknown.map((u) => `${u.bucket}/${u.id}`).join(", ")} — flag written anyway)`);
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
