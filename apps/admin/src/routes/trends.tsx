import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { UsageDigest } from "@claude-proxy/core";
import { getTrends } from "../api";
import { BarChart } from "../components/BarChart";
import { QueryState } from "../components/QueryState";
import { type Series, SeriesLineChart } from "../components/SeriesLineChart";
import { fmtInt, fmtUsd } from "../format";

const WINDOWS = [7, 14, 30];

/** Per-request token series. */
const PER_REQUEST_SERIES: Series[] = [
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

export function TrendsPage() {
  const [days, setDays] = useState(7);
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
