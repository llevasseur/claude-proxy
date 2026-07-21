import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { RequestMessageDetail } from "@claude-proxy/core";
import { getContextMessage } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt } from "../format";

export function ContextMessagePage() {
  const { file, index } = useParams({ from: "/context/$file/message/$index" });
  const idx = Number(index);
  const query = useQuery({
    queryKey: ["context-message", file, idx],
    queryFn: () => getContextMessage(file, idx),
  });
  const message = query.data?.message;

  return (
    <section>
      <div className="pagehead">
        <h1>Message #{index}</h1>
        <Link to="/context/$file" params={{ file }} className="link">
          ‹ back to breakdown
        </Link>
      </div>
      <div className="muted" style={{ marginBottom: "0.75rem", wordBreak: "break-all" }}>{file}</div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {message && <MessageBody message={message} />}
      </QueryState>
    </section>
  );
}

function MessageBody({ message: m }: { message: RequestMessageDetail }) {
  return (
    <>
      <div className="grid stats">
        <StatTile label="Position" value={`#${m.index}`} sub={`of ${m.messageCount} messages`} />
        <StatTile label="Role" value={m.role} />
        <StatTile label="Size" value={fmtBytes(m.bytes)} sub={`~${fmtInt(m.estTokens)} tokens`} />
      </div>

      <div className="card">
        <h2>Full message</h2>
        <pre className="rawjson">{m.content}</pre>
      </div>
    </>
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
