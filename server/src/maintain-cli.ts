/**
 * Headless log maintenance — `pnpm --filter server maintain`, the scheduled job
 * that owns `logs/`' lifecycle. Three steps, in order:
 *
 *   1. **Archive** every past day out of the live directory into `archive/<date>/`.
 *   2. **Evict** the `.md` and `.request.txt` bodies inside archived days older than
 *      `RETENTION_DAYS`, keeping every `.audit.json`.
 *   3. **Digest** — print the day's summary through `buildSummary`. No LLM call,
 *      no network.
 *
 * Dry run is the default; `--apply` performs it. A dry run prints the same plan
 * object `--apply` executes. See `docs/features/retention-lifecycle.md`.
 */
import { buildSummary } from './api.js';
import { resolveLogDir } from './logs.js';
import {
  applyRetention,
  collectRetentionCorpus,
  planRetention,
  resolveRetentionDays,
  resolveToday,
  type RetentionPlan,
} from './retention.js';
import { renderSummary } from './summary-render.js';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function renderPlan(plan: RetentionPlan, apply: boolean): string {
  const lines: string[] = [];
  const mode = apply ? 'apply' : 'dry run — nothing will be changed';
  lines.push(`Log maintenance — ${plan.today} (${mode})`);
  lines.push('='.repeat(28));
  lines.push(`Retention: ${plan.retentionDays} days · bodies evicted in archived days before ${plan.cutoff}`);
  lines.push('');

  if (plan.archive.moves.length === 0) {
    lines.push("Archive: nothing to move — the live directory holds only today's logs.");
  } else {
    lines.push(
      `Archive: ${plural(plan.archive.moves.length, 'file')} (${fmtBytes(plan.archive.bytes)}) ` +
        `into ${plural(plan.archive.days.length, 'day')} — ${plan.archive.days.join(', ')}`,
    );
  }

  if (plan.evict.files.length === 0) {
    lines.push(`Evict:   nothing past retention — no archived day is older than ${plan.cutoff}.`);
  } else {
    lines.push(
      `Evict:   ${plural(plan.evict.files.length, 'body file')} (${fmtBytes(plan.evict.bytes)} reclaimable) ` +
        `from ${plural(plan.evict.days.length, 'day')} — ${plan.evict.days.join(', ')}`,
    );
    lines.push('         audit sidecars are kept; no day directory is removed.');
  }

  return lines.join('\n');
}

/**
 * Distil any still-visible command runs into `logs/commands/runs.jsonl`. Must run
 * *before* archiving relocates the transcripts and bodies it reads. Skipped on a
 * dry run — it writes. Never fatal.
 */
async function reconcileRuns(logDir: string): Promise<void> {
  try {
    const { reconcileCommandRuns } = await import('./command-runs.js');
    const { written, runs } = await reconcileCommandRuns(logDir);
    if (written > 0) console.log(`[maintain] command runs: ${written} record(s) written, ${runs} stored`);
  } catch (err) {
    console.error(`[maintain] command runs skipped: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const logDir = resolveLogDir();
  const today = resolveToday();
  const retentionDays = resolveRetentionDays();

  console.log(`[maintain] log directory: ${logDir}`);
  if (apply) await reconcileRuns(logDir);

  const corpus = await collectRetentionCorpus(logDir);
  const plan = planRetention({ corpus, today, retentionDays });
  console.log(renderPlan(plan, apply));

  if (apply) {
    const result = await applyRetention(logDir, plan);
    console.log('');
    console.log(
      `Applied: archived ${plural(result.archived, 'file')}, evicted ${plural(result.evicted, 'file')}, ` +
        `reclaimed ${fmtBytes(result.bytesReclaimed)}`,
    );
    for (const err of result.errors.slice(0, 10)) console.error(`[maintain] ${err}`);
    if (result.errors.length > 10) console.error(`[maintain] …and ${result.errors.length - 10} more`);
  } else if (plan.archive.moves.length > 0 || plan.evict.files.length > 0) {
    console.log('');
    console.log('Re-run with --apply to perform this.');
  }

  console.log('');
  console.log(renderSummary(await buildSummary(logDir, today)));
}

main().catch((err: unknown) => {
  console.error(`[maintain] error: ${(err as Error).message}`);
  process.exitCode = 1;
});
