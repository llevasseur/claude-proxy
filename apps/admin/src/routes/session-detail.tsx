import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { SessionDetail } from "../api";
import { getSession } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Markdown } from "../components/Markdown";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt, fmtLocalTsShort } from "../format";

export function SessionDetailPage() {
  const { id } = useParams({ from: "/sessions/$id" });
  const query = useQuery({
    queryKey: ["session", id],
    queryFn: () => getSession(id),
  });
  const session = query.data?.session;

  return (
    <section>
      <Breadcrumbs>
        <Link to="/sessions" className="link">
          Sessions
        </Link>
        <span className="crumb-current">{id}</span>
      </Breadcrumbs>
      <div className="pagehead">
        <h1 className="mono-break">{id}</h1>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {session && <SessionBody session={session} />}
      </QueryState>
    </section>
  );
}

function SessionBody({ session }: { session: SessionDetail }) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");
  const { meta } = session;

  return (
    <>
      <div className="grid stats">
        <StatTile label="Model" value={meta.model ?? "—"} />
        <StatTile label="Started" value={meta.started ? fmtLocalTsShort(meta.started) : "—"} />
        <StatTile label="Tasks" value={fmtInt(meta.tasks)} />
        <StatTile label="Tools" value={fmtInt(meta.tools)} />
        <StatTile label="Decisions" value={fmtInt(meta.decisions)} />
        <ErrorsStatTile threadId={meta.threadId} errors={meta.errors} />
      </div>

      {meta.sessionId && (
        <div className="muted mono-break" style={{ margin: "0.5rem 0 0.75rem" }}>
          session {meta.sessionId} · {fmtBytes(session.bytes)}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Transcript</h2>
          <div className="segmented">
            <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>
              Pretty
            </button>
            <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>
              Raw
            </button>
          </div>
        </div>
        {view === "pretty" ? (
          <div className="memory-pretty">
            <Markdown source={session.content} />
          </div>
        ) : (
          <pre className="rawjson wrap">{session.content}</pre>
        )}
      </div>
    </>
  );
}

/** Errors stat tile: links to the per-session error drill-down when non-zero, a muted zero otherwise. */
function ErrorsStatTile({ threadId, errors }: { threadId: string; errors: number }) {
  if (errors === 0) {
    return (
      <div className="card stat">
        <div className="stat-label">Errors</div>
        <div className="stat-value muted">0</div>
        <div className="stat-foot" />
      </div>
    );
  }
  return (
    <Link to="/sessions/$id/errors" params={{ id: threadId }} className="card stat stat-error">
      <div className="stat-label">Errors</div>
      <div className="stat-value">{fmtInt(errors)}</div>
      <div className="stat-foot">
        <span className="stat-error-cta">view details →</span>
      </div>
    </Link>
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
