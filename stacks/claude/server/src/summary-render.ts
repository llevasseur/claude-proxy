/**
 * The text rendering of a day's digest, shared by `daily-summary` and `maintain`.
 * It lives apart from both because each is a script with top-level side effects —
 * importing one to reuse its renderer would run its job.
 */
import { reportTzAbbr, type UsageDigest } from '@claude-proxy/core';
import type { SummaryResponse } from './api.js';

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function trendLine(d: UsageDigest): string {
  if (!d.trend) return '';
  // Two fields need not share a baseline: name it in the header when they agree,
  // per figure when they don't.
  const dates = new Set(d.trend.flatMap((t) => (t.priorDate ? [t.priorDate] : [])));
  const mixed = dates.size > 1;
  const parts = d.trend.map((t) => {
    const pct = `${t.deltaPct >= 0 ? '+' : ''}${t.deltaPct.toFixed(0)}%`;
    return mixed && t.priorDate ? `${t.field} ${pct} (vs ${t.priorDate})` : `${t.field} ${pct}`;
  });
  const against = dates.size === 1 ? [...dates][0] : 'last recorded day';
  return `  vs ${against}: ${parts.join(', ')}`;
}

/** One day's digest and advice as a readable text block. */
export function renderSummary({ digest: d, advice, meta }: SummaryResponse): string {
  const lines: string[] = [];
  lines.push(`Claude usage — ${d.date}`);
  lines.push('='.repeat(28));

  if (d.requestCount === 0) {
    lines.push('No Claude activity captured for this day.');
    if (meta.parseErrors) lines.push(`(${meta.parseErrors} unreadable sidecar file(s))`);
    return lines.join('\n');
  }

  const models = Object.entries(d.models)
    .map(([m, c]) => `${m}×${c}`)
    .join(', ');
  lines.push(`Requests: ${d.requestCount}   Models: ${models}`);
  lines.push(
    `Tokens: ${d.tokens.realInput.toLocaleString()} in / ${d.tokens.output.toLocaleString()} out` +
      `   Cache hit: ${(d.tokens.cacheHitRatio * 100).toFixed(0)}%`,
  );
  lines.push(`Est. cost: ${usd(d.cost.total)} (out ${usd(d.cost.output)}, cache-write ${usd(d.cost.cacheWrite)})`);
  if (d.busiestHour)
    lines.push(
      `Busiest hour: ${String(d.busiestHour.hour).padStart(2, '0')}:00 ${reportTzAbbr(new Date(`${d.date}T12:00:00.000Z`))} (${d.busiestHour.requestCount} req)`,
    );
  const trend = trendLine(d);
  if (trend) lines.push(trend);

  if (d.topTools.length) {
    lines.push('');
    lines.push('Top context-eating tools:');
    for (const t of d.topTools.slice(0, 5)) {
      lines.push(
        `  ${t.name.padEnd(16)} ${t.pctOfToolBytes.toFixed(1)}% of tool bytes  (~${t.estTokens.toLocaleString()} tok)`,
      );
    }
  }

  lines.push('');
  lines.push('Advice:');
  for (const a of advice) lines.push(`  [${a.severity}] ${a.title}\n    ${a.detail}`);

  if (meta.parseErrors) lines.push(`\n(${meta.parseErrors} unreadable sidecar file(s) skipped)`);
  return lines.join('\n');
}
