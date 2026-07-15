/**
 * Headless daily summary — the CLI counterpart to the dashboard. Computes
 * today's (or a given day's) digest + advice from the audit logs and prints a
 * readable text block. This is the hook point for a scheduled job (e.g. launchd
 * from the 2026-07-13 spec).
 *
 *   pnpm --filter server summary            # today
 *   pnpm --filter server summary 2026-07-14 # a specific day
 */
import type { UsageDigest } from "@claude-proxy/core";
import { buildSummary, type SummaryResponse } from "./api.js";
import { resolveLogDir } from "./logs.js";

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function trendLine(d: UsageDigest): string {
  if (!d.trend) return "";
  const parts = d.trend.map((t) => `${t.field} ${t.deltaPct >= 0 ? "+" : ""}${t.deltaPct.toFixed(0)}%`);
  return `  vs prior day: ${parts.join(", ")}`;
}

function render({ digest: d, advice, meta }: SummaryResponse): string {
  const lines: string[] = [];
  lines.push(`Claude usage — ${d.date}`);
  lines.push("=".repeat(28));

  if (d.requestCount === 0) {
    lines.push("No Claude activity captured for this day.");
    if (meta.parseErrors) lines.push(`(${meta.parseErrors} unreadable sidecar file(s))`);
    return lines.join("\n");
  }

  const models = Object.entries(d.models)
    .map(([m, c]) => `${m}×${c}`)
    .join(", ");
  lines.push(`Requests: ${d.requestCount}   Models: ${models}`);
  lines.push(
    `Tokens: ${d.tokens.realInput.toLocaleString()} in / ${d.tokens.output.toLocaleString()} out` +
      `   Cache hit: ${(d.tokens.cacheHitRatio * 100).toFixed(0)}%`,
  );
  lines.push(`Est. cost: ${usd(d.cost.total)} (out ${usd(d.cost.output)}, cache-write ${usd(d.cost.cacheWrite)})`);
  if (d.busiestHour) lines.push(`Busiest hour: ${String(d.busiestHour.hour).padStart(2, "0")}:00 UTC (${d.busiestHour.requestCount} req)`);
  const trend = trendLine(d);
  if (trend) lines.push(trend);

  if (d.topTools.length) {
    lines.push("");
    lines.push("Top context-eating tools:");
    for (const t of d.topTools.slice(0, 5)) {
      lines.push(`  ${t.name.padEnd(16)} ${t.pctOfToolBytes.toFixed(1)}% of tool bytes  (~${t.estTokens.toLocaleString()} tok)`);
    }
  }

  lines.push("");
  lines.push("Advice:");
  for (const a of advice) lines.push(`  [${a.severity}] ${a.title}\n    ${a.detail}`);

  if (meta.parseErrors) lines.push(`\n(${meta.parseErrors} unreadable sidecar file(s) skipped)`);
  return lines.join("\n");
}

const dateArg = process.argv[2];
buildSummary(resolveLogDir(), dateArg)
  .then((summary: SummaryResponse) => {
    console.log(render(summary));
  })
  .catch((err: unknown) => {
    console.error(`[daily-summary] error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
