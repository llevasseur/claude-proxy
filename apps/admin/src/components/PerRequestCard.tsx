import type { UsageDigest } from "@claude-proxy/core";
import { fmtInt } from "../format";
import { type Series, SeriesLineChart } from "./SeriesLineChart";
import { SkeletonChartCard } from "./Skeleton";

/** Per-request token series. */
export const PER_REQUEST_SERIES: Series[] = [
  { dataKey: "realInput", name: "Real input", color: "var(--accent)" },
  { dataKey: "output", name: "Output", color: "var(--good)" },
  { dataKey: "cache", name: "Cache", color: "var(--accent-2)" },
];

const perReq = (total: number, requests: number) => (requests > 0 ? Math.round(total / requests) : 0);

/** Tokens-per-request row for one day. */
function toPerRequestRow(d: UsageDigest) {
  return {
    label: d.date.slice(5),
    realInput: perReq(d.tokens.realInput, d.requestCount),
    output: perReq(d.tokens.output, d.requestCount),
    cache: perReq(d.tokens.cacheRead + d.tokens.cacheCreation, d.requestCount),
  };
}

/** Tokens per request across every day in the selected window. */
export function PerRequestCard({ digests }: { digests: UsageDigest[] }) {
  const rows = digests.map(toPerRequestRow);
  const first = digests.at(0);
  const last = digests.at(-1);
  const rangeLabel = !first || !last ? "—" : first.date === last.date ? first.date : `${first.date} → ${last.date}`;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Tokens per request</h2>
        <span className="range">{rangeLabel}</span>
      </div>
      <SeriesLineChart data={rows} series={PER_REQUEST_SERIES} xKey="label" format={fmtInt} />
      <div className="chartlegend">
        {PER_REQUEST_SERIES.map((s) => (
          <span className="chartlegend-item" key={s.dataKey}>
            <span className="chartlegend-swatch" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The card at its loaded size — the plot carries a legend under it, so reserve those rows too. */
export function PerRequestSkeleton({ days }: { days: number }) {
  return <SkeletonChartCard title="Tokens per request" bars={days} legend={PER_REQUEST_SERIES.length} />;
}
