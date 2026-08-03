/**
 * Backfill system-prompt identity onto historical sidecars —
 * `pnpm --filter server prompt-backfill [--apply]`.
 *
 * Dry run is the default and prints the same counts `--apply` would produce.
 * Reaches only as far back as retention has kept `.request.txt` bodies; older
 * sidecars keep their model+size-band cohort.
 */
import { resolveLogDir } from "./logs.js";
import { backfillPromptIdentity, type BackfillReport } from "./prompt-backfill.js";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function render(report: BackfillReport, apply: boolean): string {
  const verb = apply ? "Tagged" : "Would tag";
  return [
    `Scanned ${plural(report.scanned, "sidecar")}`,
    `  ${verb.padEnd(9)} ${plural(report.tagged, "sidecar")} across ${plural(report.distinctPrompts, "distinct prompt")}`,
    `  ${(apply ? "Stored" : "Would store").padEnd(9)} ${plural(report.promptsStored, "outline")} in logs/system-prompts/`,
    "",
    "Skipped:",
    `  already tagged  ${report.alreadyTagged.toLocaleString()}`,
    `  body evicted    ${report.bodyMissing.toLocaleString()}`,
    `  no system field ${report.noSystem.toLocaleString()}`,
    `  unreadable      ${report.unparseable.toLocaleString()}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const logDir = resolveLogDir();

  console.log(`[prompt-backfill] log directory: ${logDir}`);
  console.log(`[prompt-backfill] ${apply ? "applying" : "dry run — nothing will be written"}`);

  let lastPct = -1;
  const report = await backfillPromptIdentity(logDir, {
    apply,
    onProgress: (done, total) => {
      const pct = total > 0 ? Math.floor((done / total) * 10) * 10 : 100;
      if (pct !== lastPct) {
        lastPct = pct;
        console.log(`[prompt-backfill] ${pct}% (${done.toLocaleString()}/${total.toLocaleString()})`);
      }
    },
  });

  console.log("");
  console.log(render(report, apply));
  for (const err of report.errors.slice(0, 10)) console.error(`[prompt-backfill] ${err}`);
  if (report.errors.length > 10) console.error(`[prompt-backfill] …and ${report.errors.length - 10} more`);
  if (!apply && report.tagged > 0) {
    console.log("");
    console.log("Re-run with --apply to write this.");
  }
}

main().catch((err: unknown) => {
  console.error(`[prompt-backfill] error: ${(err as Error).message}`);
  process.exitCode = 1;
});
