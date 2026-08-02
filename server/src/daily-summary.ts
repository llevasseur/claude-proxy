/**
 * Headless daily summary — the CLI counterpart to the dashboard. Computes
 * today's (or a given day's) digest + advice from the audit logs and prints a
 * readable text block. This is the hook point for a scheduled job (e.g. launchd
 * from the 2026-07-13 spec).
 *
 *   pnpm --filter server summary            # today
 *   pnpm --filter server summary 2026-07-14 # a specific day
 */
import { buildSummary, type SummaryResponse } from "./api.js";
import { resolveLogDir } from "./logs.js";
import { renderSummary } from "./summary-render.js";

/**
 * Distil any command runs still visible into `logs/commands/runs.jsonl` before the day
 * rolls. The dashboard reconciles on every read, but only while it is running — this is
 * the backstop for a machine whose server is off, and it has to happen before the raw
 * transcripts and request bodies age out. Same idempotent pass, so it costs nothing when
 * the dashboard already did it. Never fatal: the summary is the job's actual output.
 */
async function reconcileRuns(logDir: string): Promise<void> {
  try {
    const { reconcileCommandRuns } = await import("./command-runs.js");
    const { written, runs } = await reconcileCommandRuns(logDir);
    if (written > 0) console.log(`[daily-summary] command runs: ${written} record(s) written, ${runs} stored\n`);
  } catch (err) {
    console.error(`[daily-summary] command runs skipped: ${(err as Error).message}`);
  }
}

const dateArg = process.argv[2];
const logDir = resolveLogDir();
reconcileRuns(logDir)
  .then(() => buildSummary(logDir, dateArg))
  .then((summary: SummaryResponse) => {
    console.log(renderSummary(summary));
  })
  .catch((err: unknown) => {
    console.error(`[daily-summary] error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
