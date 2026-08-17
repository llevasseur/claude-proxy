/**
 * Headless log maintenance — `pnpm --filter server maintain`, the scheduled job
 * that owns `logs/`' lifecycle. Three steps, in order:
 *
 *   1. **Archive** every past day out of the live directory into `archive/<date>/`.
 *   2. **Evict** the `.md` and `.request.txt` bodies inside archived days older than
 *      `RETENTION_DAYS`, keeping every `.audit.json`. `RETENTION_DAYS=never` turns
 *      this one step off; step 1 and step 3 run exactly as they otherwise would.
 *   3. **Digest** — print the day's summary through `buildSummary`. No LLM call,
 *      no network.
 *
 * Dry run is the default; `--apply` performs it. A dry run prints the same plan
 * object `--apply` executes. Either way it prices what is being **kept** as well
 * as what is being reclaimed, so the scheduled job's log is a growth record and
 * not only a reclamation one. See `docs/features/retention-lifecycle.md`.
 */
import { buildSummary } from './api.js';
import { resolveArchiveDir } from './archive.js';
import { errorMessage } from './errors.js';
import { resolveLogDir } from './logs.js';
import {
  applyRetention,
  collectRetentionCorpus,
  planRetention,
  RETENTION_NEVER,
  type RetentionPlan,
  resolveRetentionWindow,
  resolveToday,
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

/**
 * What the run is choosing to keep, and where that leads. Printed on every run,
 * not only a dry one — the scheduled job runs `--apply`, and its log is where
 * this corpus's growth is recorded.
 */
function renderKeep(plan: RetentionPlan): string[] {
  const { keep } = plan;
  const lines: string[] = [];
  const sidecars = keep.bytes - keep.bodyBytes;
  lines.push(
    `Keeping: ${fmtBytes(keep.bytes)} after this run — ${fmtBytes(keep.bodyBytes)} of bodies, ` +
      `${fmtBytes(sidecars)} of everything else.`,
  );

  if (keep.bodyBytesPerDay === 0) {
    lines.push('         no bodies retained, so there is no rate to project.');
    return lines;
  }

  lines.push(
    `         ${fmtBytes(keep.bodyBytesPerDay)}/day of bodies observed over ` +
      `${plural(keep.spanDays, 'retained day')} (${plural(keep.days.length, 'day')} with capture).`,
  );
  lines.push(`         at that rate: ${keep.projection.map((p) => `${p.days}d ${fmtBytes(p.bytes)}`).join(' · ')}`);
  lines.push(
    keep.steadyStateBytes === null
      ? `         retention is ${RETENTION_NEVER}, so nothing bounds that — the projection is the bill for keeping everything.`
      : `         a ${plan.retentionDays}-day window bounds it at ~${fmtBytes(keep.steadyStateBytes)} of bodies.`,
  );
  return lines;
}

function renderPlan(plan: RetentionPlan, apply: boolean): string {
  const lines: string[] = [];
  const mode = apply ? 'apply' : 'dry run — nothing will be changed';
  lines.push(`Log maintenance — ${plan.today} (${mode})`);
  lines.push('='.repeat(28));
  lines.push(
    plan.cutoff === null
      ? `Retention: ${RETENTION_NEVER} · nothing is ever evicted; archiving still runs.`
      : `Retention: ${plan.retentionDays} days · bodies evicted in archived days before ${plan.cutoff}`,
  );
  lines.push('');

  if (plan.archive.moves.length === 0) {
    lines.push("Archive: nothing to move — the live directory holds only today's logs.");
  } else {
    lines.push(
      `Archive: ${plural(plan.archive.moves.length, 'file')} (${fmtBytes(plan.archive.bytes)}) ` +
        `into ${plural(plan.archive.days.length, 'day')} — ${plan.archive.days.join(', ')}`,
    );
  }

  if (plan.cutoff === null) {
    lines.push(`Evict:   off — \`RETENTION_DAYS=${RETENTION_NEVER}\` keeps every body ever captured.`);
  } else if (plan.evict.files.length === 0) {
    lines.push(`Evict:   nothing past retention — no archived day is older than ${plan.cutoff}.`);
  } else {
    lines.push(
      `Evict:   ${plural(plan.evict.files.length, 'body file')} (${fmtBytes(plan.evict.bytes)} reclaimable) ` +
        `from ${plural(plan.evict.days.length, 'day')} — ${plan.evict.days.join(', ')}`,
    );
    lines.push('         audit sidecars are kept; no day directory is removed.');
  }

  lines.push('');
  lines.push(...renderKeep(plan));

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
  } catch (cause) {
    console.error(`[maintain] command runs skipped: ${errorMessage(cause)}`);
  }
}

/**
 * Extract the derivatives the dashboard reads out of a body, while the bodies are
 * all still here. Must run *before* the evict phase below deletes them, for the
 * same reason `reconcileRuns` must run before archiving: the step consumes
 * something a later step in this very run removes.
 *
 * An ordinary ingest pass — the watcher and `pnpm --filter server ingest` run the
 * same one, so this is usually a no-op that finds nothing pending, and having it
 * here is what makes the ordering a guarantee. Skipped on a dry run, and never
 * fatal: the substrate is a disposable view.
 */
async function deriveBeforeEvict(logDir: string): Promise<void> {
  try {
    const { ingestOnce } = await import('./db/runtime.js');
    const stats = await ingestOnce(logDir);
    if (stats.derived > 0) console.log(`[maintain] derived ${plural(stats.derived, 'body')} before eviction`);
  } catch (cause) {
    console.error(`[maintain] body derivation skipped: ${errorMessage(cause)}`);
  }
}

/**
 * Level the substrate with what the evict phase just deleted.
 *
 * {@link deriveBeforeEvict} runs *before* eviction, so it cannot see it, and
 * eviction inside `archive/<day>/` fires no watcher event — the server's watch
 * is not recursive. Without a pass on this side, `request_path` keeps pointing
 * at bodies this run removed. `/api/skim/trend` sums that column, so a stale one
 * is a wrong answer rather than merely a slow one. Never fatal: the substrate is
 * a disposable view.
 */
async function reingestAfterEvict(logDir: string): Promise<void> {
  try {
    const { ingestOnce } = await import('./db/runtime.js');
    const stats = await ingestOnce(logDir);
    if (stats.dirs > 0) {
      console.log(`[maintain] re-ingested ${plural(stats.dirs, 'directory', 'directories')} after eviction`);
    }
  } catch (cause) {
    console.error(`[maintain] post-eviction ingest skipped: ${errorMessage(cause)}`);
  }
}

/**
 * Move each `claimed` idea whose pull request has merged, closed, or lost its
 * head branch. Skipped on a dry run — it writes. Never fatal: no `gh`, no
 * network, no origin all mean "learned nothing this run", and the ledger is left
 * exactly as it was.
 */
async function reconcileIdeas(): Promise<void> {
  try {
    const { reconcileIdeaPrs, renderIdeaPrTransition } = await import('./ideas-pr.js');
    const result = await reconcileIdeaPrs();
    if (result.error) {
      console.error(`[maintain] ideas: pull requests unreadable (${result.error}) — the ledger is untouched`);
      return;
    }
    for (const t of result.transitions) console.log(`[maintain] ideas: ${renderIdeaPrTransition(t)}`);
  } catch (cause) {
    console.error(`[maintain] ideas skipped: ${errorMessage(cause)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const logDir = resolveLogDir();
  const today = resolveToday();
  const retentionDays = resolveRetentionWindow();

  console.log(`[maintain] log directory: ${logDir}`);
  if (apply) {
    await reconcileRuns(logDir);
    await deriveBeforeEvict(logDir);
    // Last of the three: unlike the two above it consumes nothing a later phase
    // of this run removes, so it has no ordering constraint to honour.
    await reconcileIdeas();
  }

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

    // After the eviction, not before it — see the note on the function.
    if (result.evicted > 0 || result.archived > 0) await reingestAfterEvict(logDir);
  } else if (plan.archive.moves.length > 0 || plan.evict.files.length > 0) {
    console.log('');
    console.log('Re-run with --apply to perform this.');
  }

  console.log('');
  console.log(renderSummary(await buildSummary(logDir, today, new Date(), resolveArchiveDir())));
}

main().catch((cause: unknown) => {
  console.error(`[maintain] error: ${errorMessage(cause)}`);
  process.exitCode = 1;
});
