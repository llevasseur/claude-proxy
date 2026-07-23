import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { getTrends } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { QueryState } from "../components/QueryState";
import { SeriesLineChart } from "../components/SeriesLineChart";
import { findMetric } from "../metrics";

const WINDOWS = [7, 14, 30];

/** Large-scale trend for one Overview statistic, reached by clicking its card. */
export function TrendDetailPage() {
  const { metric } = useParams({ from: "/trends/$metric" });
  const def = findMetric(metric);
  const [days, setDays] = useState(30);
  const query = useQuery({ queryKey: ["trends", days], queryFn: () => getTrends(days), enabled: !!def });
  const digests = query.data?.digests ?? [];

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
        <div className="segmented">
          {WINDOWS.map((w) => (
            <button key={w} className={w === days ? "active" : ""} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {digests.length === 0 ? (
          <div className="card empty">No usage captured in the last {days} days.</div>
        ) : (
          <>
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
                height={340}
              />
            </div>

            <div className="card">
              <h2>By day</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
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
          </>
        )}
      </QueryState>
    </section>
  );
}
