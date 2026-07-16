import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getTrends } from "../api";
import { BarChart } from "../components/BarChart";
import { QueryState } from "../components/QueryState";
import { fmtInt, fmtUsd } from "../format";

const WINDOWS = [7, 14, 30];

export function TrendsPage() {
  const [days, setDays] = useState(14);
  const query = useQuery({ queryKey: ["trends", days], queryFn: () => getTrends(days) });
  const digests = query.data?.digests ?? [];

  return (
    <section>
      <div className="pagehead">
        <h1>Trends</h1>
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
                    <th>Date</th>
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
