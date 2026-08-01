import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { UsageDigest } from "@claude-proxy/core";
import { getTrends } from "../api";
import { BAR_CHART_HEIGHT, BarChart } from "../components/BarChart";
import { QueryState } from "../components/QueryState";
import { DAY_WINDOWS, Segmented } from "../components/Segmented";
import { type SkeletonColumn, SkeletonChartCard, SkeletonTableCard } from "../components/Skeleton";
import { type Series, SeriesLineChart } from "../components/SeriesLineChart";
import { fmtInt, fmtUsd } from "../format";
import { REPORT_TZ_ABBR } from "../metrics";
import { useTransitionState } from "../useTransitionState";

/** Per-request token series. */
const PER_REQUEST_SERIES: Series[] = [
  { dataKey: "realInput", name: "Real input", color: "var(--accent)" },
  { dataKey: "output", name: "Output", color: "var(--good)" },
  { dataKey: "cache", name: "Cache", color: "var(--accent-2)" },
];

/** Date, then five numeric columns — the by-day table's shape. */
const BY_DAY_COLUMNS: readonly SkeletonColumn[] = [
  {},
  { className: "num" },
  { className: "num" },
  { className: "num" },
  { className: "num" },
  { className: "num" },
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

export function TrendsPage() {
  const [days, selectDays, isSwitching] = useTransitionState(7);
  const query = useQuery({
    queryKey: ["trends", days],
    queryFn: () => getTrends(days),
    placeholderData: keepPreviousData,
  });
  const digests = query.data?.digests ?? [];
  const busy = isSwitching || query.isFetching;

  return (
    <section>
      <div className="pagehead">
        <h1>Trends</h1>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label="Trend window" busy={busy} />
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        skeleton={<TrendsSkeleton days={days} />}
        busy={busy}
      >
        {digests.length === 0 ? (
          <div className="card empty">No usage captured in the last {days} days.</div>
        ) : (
          <>
            <PerRequestCard digests={digests} />
            <div className="card">
              <h2>Real input tokens / day</h2>
              <BarChart data={digests.map((d) => ({ label: d.date, value: d.tokens.realInput }))} format={fmtInt} />
            </div>
            <div className="card">
              <h2>Estimated cost / day</h2>
              <BarChart
                data={digests.map((d) => ({ label: d.date, value: d.cost.total }))}
                format={fmtUsd}
                color="var(--accent-2)"
              />
            </div>
            <div className="card">
              <h2>By day</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date ({REPORT_TZ_ABBR})</th>
                    <th className="num">Requests</th>
                    <th className="num">Real input</th>
                    <th className="num">Output</th>
                    <th className="num">Cache hit</th>
                    <th className="num">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...digests].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td className="num">{fmtInt(d.requestCount)}</td>
                      <td className="num">{fmtInt(d.tokens.realInput)}</td>
                      <td className="num">{fmtInt(d.tokens.output)}</td>
                      <td className="num">{(d.tokens.cacheHitRatio * 100).toFixed(0)}%</td>
                      <td className="num">{fmtUsd(d.cost.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The four cards at the selected window's size: one row and one bar per day. */
function TrendsSkeleton({ days }: { days: number }) {
  return (
    <>
      {/* The per-request card carries a legend under its plot; reserve those rows too. */}
      <SkeletonChartCard title="Tokens per request" bars={days} legend={PER_REQUEST_SERIES.length} />
      <SkeletonChartCard title="Real input tokens / day" height={BAR_CHART_HEIGHT} bars={days} />
      <SkeletonChartCard title="Estimated cost / day" height={BAR_CHART_HEIGHT} bars={days} />
      <SkeletonTableCard title="By day" columns={BY_DAY_COLUMNS} rows={days} />
    </>
  );
}

/** Tokens per request across every day in the selected window. */
function PerRequestCard({ digests }: { digests: UsageDigest[] }) {
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
