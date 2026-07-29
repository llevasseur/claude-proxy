import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { getTrends } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { QueryState } from "../components/QueryState";
import { DAY_WINDOWS, Segmented } from "../components/Segmented";
import { type SkeletonColumn, SkeletonChartCard, SkeletonTableCard } from "../components/Skeleton";
import { SeriesLineChart } from "../components/SeriesLineChart";
import { findMetric, REPORT_TZ_ABBR } from "../metrics";
import { useTransitionState } from "../useTransitionState";

/** The tall chart this page leads with, in px. */
const CHART_HEIGHT = 340;

/** Date and the metric's own value. */
const BY_DAY_COLUMNS: readonly SkeletonColumn[] = [{}, { className: "num" }];

/** Large-scale trend for one Overview statistic, reached by clicking its card. */
export function TrendDetailPage() {
  const { metric } = useParams({ from: "/trends/$metric" });
  const def = findMetric(metric);
  const [days, selectDays, isSwitching] = useTransitionState(30);
  const query = useQuery({
    queryKey: ["trends", days],
    queryFn: () => getTrends(days),
    enabled: !!def,
    placeholderData: keepPreviousData,
  });
  const digests = query.data?.digests ?? [];
  const busy = isSwitching || query.isFetching;

  if (!def) {
    return (
      <section>
        <Breadcrumbs>
          <Link to="/trends" className="link">
            Trends
          </Link>
          <span className="crumb-current">Unknown</span>
        </Breadcrumbs>
        <div className="card empty">No trend metric named “{metric}”.</div>
      </section>
    );
  }

  const rows = digests.map((d) => ({ label: d.date, value: def.value(d) }));
  const first = digests.at(0);
  const last = digests.at(-1);
  const rangeLabel = !first || !last ? "—" : first.date === last.date ? first.date : `${first.date} → ${last.date}`;

  return (
    <section>
      <Breadcrumbs>
        <Link to="/trends" className="link">
          Trends
        </Link>
        <span className="crumb-current">{def.label}</span>
      </Breadcrumbs>

      <div className="pagehead">
        <div>
          <h1>{def.title ?? def.label}</h1>
          <div className="muted">{def.description}</div>
        </div>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label="Trend window" busy={busy} />
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        skeleton={<TrendDetailSkeleton days={days} label={def.label} />}
        busy={busy}
      >
        {digests.length === 0 ? (
          <div className="card empty">No usage captured in the last {days} days.</div>
        ) : (
          <div className="grid wide-two chart-lead">
            <div className="card">
              <div className="card-head">
                <h2>{def.label} / day</h2>
                <span className="range">{rangeLabel}</span>
              </div>
              <SeriesLineChart
                data={rows}
                series={[{ dataKey: "value", name: def.label, color: def.color }]}
                xKey="label"
                format={def.format}
                height={CHART_HEIGHT}
              />
            </div>

            <div className="card">
              <h2>By day</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date ({REPORT_TZ_ABBR})</th>
                    <th className="num">{def.label}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="num">{def.format(r.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>
    </section>
  );
}

/**
 * The chart and its by-day table, side by side in the same two-up grid the loaded
 * page uses — one row and one plotted point per day in the window.
 */
function TrendDetailSkeleton({ days, label }: { days: number; label: string }) {
  return (
    <div className="grid wide-two chart-lead">
      <SkeletonChartCard title={`${label} / day`} height={CHART_HEIGHT} bars={days} />
      <SkeletonTableCard title="By day" columns={BY_DAY_COLUMNS} rows={days} />
    </div>
  );
}
