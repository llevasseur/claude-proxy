import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { getContext } from "../api";
import { QueryState } from "../components/QueryState";
import { StatCard } from "../components/StatCard";
import { fmtBytes, fmtInt } from "../format";

const WINDOWS = [7, 14, 30];

/** `MM-DD HH:MM:SS` (UTC) — terse, matches the rest of the admin. */
function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 19)}`;
}

export function ContextPage() {
  const [days, setDays] = useState(14);
  const query = useQuery({ queryKey: ["context", days], queryFn: () => getContext(days) });
  const summary = query.data?.summary;
  const top = summary?.top ?? [];
  const max = Math.max(1, ...top.map((e) => e.realInput));

  return (
    <section>
      <div className="pagehead">
        <h1>Context size</h1>
        <div className="segmented">
          {WINDOWS.map((w) => (
            <button key={w} className={w === days ? "active" : ""} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!summary || summary.requestCount === 0 ? (
          <div className="card empty">No context captured in the last {days} days.</div>
        ) : (
          <>
            <div className="muted" style={{ marginBottom: "0.75rem" }}>
              Real input tokens (input + cache) — the true prompt size sent to the model · {summary.requestCount}{" "}
              request{summary.requestCount === 1 ? "" : "s"}
            </div>

            <div className="grid stats">
              <StatCard label="Average context" value={fmtInt(summary.avgRealInput)} sub="tokens / request" />
              <StatCard label="Median context" value={fmtInt(summary.medianRealInput)} sub="tokens / request" />
              <StatCard label="Largest context" value={fmtInt(summary.maxRealInput)} sub="tokens" />
              <StatCard label="Requests" value={fmtInt(summary.requestCount)} sub={`last ${days} days`} />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Largest requests</h2>
                <span className="muted">peak first · click a row for the breakdown</span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>When (UTC)</th>
                    <th>Model</th>
                    <th className="num">Real input</th>
                    <th className="num">System</th>
                    <th className="num">Tools</th>
                    <th className="bar-col">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((e, i) => (
                    <tr key={e.file}>
                      <td>
                        <Link to="/context/$file" params={{ file: e.file }} className="link">
                          {fmtTs(e.timestamp)}
                          {i === 0 && <span className="muted"> · peak</span>}
                        </Link>
                      </td>
                      <td className="muted">{e.model}</td>
                      <td className="num">{fmtInt(e.realInput)}</td>
                      <td className="num">{fmtBytes(e.systemBytes)}</td>
                      <td className="num">{fmtBytes(e.toolsBytes)}</td>
                      <td className="bar-col">
                        <div className="rowbar" style={{ width: `${(e.realInput / max) * 100}%` }} />
                      </td>
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
