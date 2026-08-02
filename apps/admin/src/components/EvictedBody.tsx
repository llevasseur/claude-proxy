import type { EvictedBodyResponse } from "../api";
import { fmtBytes, fmtInt } from "../format";

/**
 * What a body-reading drill-down shows once retention has evicted the body. Not
 * an error state: the sidecar is kept, so the request is still fully described by
 * its metrics and only the verbatim text is gone.
 */
export function EvictedBody({ data }: { data: EvictedBodyResponse }) {
  const r = data.retained;
  return (
    <>
      <div className="card">
        <h2>Body evicted after {data.retentionDays} days — metrics retained</h2>
        <p className="muted">
          The captured request body was deleted by log retention
          {data.day ? ` (archived ${data.day})` : ""}. Its audit sidecar is kept permanently, so the
          measurements below are complete — only the request text itself is gone.
        </p>
      </div>

      {r ? (
        <>
          <div className="grid stats">
            <StatTile label="Total request" value={fmtBytes(r.request.totalBytes)} sub={`~${fmtInt(Math.round(r.request.totalBytes / 4))} tokens`} />
            <StatTile label="Tools" value={String(r.request.toolCount)} sub={fmtBytes(r.request.toolsBytes)} />
            <StatTile label="System prompt" value={fmtBytes(r.request.systemBytes)} />
            <StatTile label="Real input" value={fmtInt(r.tokens.realInput)} sub="tokens" />
          </div>

          <div className="card">
            <h2>Retained metrics</h2>
            <table className="table">
              <tbody>
                <Row label="Captured" value={r.timestamp} />
                <Row label="Model" value={r.model} />
                <Row label="Endpoint" value={r.endpoint} />
                <Row label="Status" value={String(r.statusCode)} />
                <Row label="Input tokens" value={fmtInt(r.tokens.input)} />
                <Row label="Output tokens" value={fmtInt(r.tokens.output)} />
                <Row label="Cache read" value={fmtInt(r.tokens.cacheRead)} />
                <Row label="Cache creation" value={fmtInt(r.tokens.cacheCreation)} />
              </tbody>
            </table>
          </div>

          {r.tools.length > 0 && (
            <div className="card">
              <h2>Tools by size</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th className="num">Bytes</th>
                    <th className="num">~Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {r.tools.map((t) => (
                    <tr key={t.name}>
                      <td>{t.name}</td>
                      <td className="num">{fmtBytes(t.bytes)}</td>
                      <td className="num">{fmtInt(t.estTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="card">
          <div className="empty">The audit sidecar for this request could not be read.</div>
        </div>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{value}</td>
    </tr>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">{sub && <span className="muted">{sub}</span>}</div>
    </div>
  );
}
