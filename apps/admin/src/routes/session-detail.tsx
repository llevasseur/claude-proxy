import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { SessionDetail } from "../api";
import { getRunningChats, getSession, getSessionBreakdown, stopChat } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { LiveIndicator } from "../components/LiveIndicator";
import { Markdown } from "../components/Markdown";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt, fmtLocalTsShort } from "../format";
import { useLiveQuery } from "../useLiveQuery";

export function SessionDetailPage() {
  const { id } = useParams({ from: "/sessions/$id" });
  const query = useQuery({
    queryKey: ["session", id],
    queryFn: () => getSession(id),
  });
  // Stream live appends into the same cache key; the query above is the fallback.
  const live = useLiveQuery(`/api/sessions/session/stream?id=${encodeURIComponent(id)}`, ["session", id]);
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
        <LiveIndicator status={live} />
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
      {(meta.title || meta.subtitle) && (
        <div className="session-heading">
          {meta.title && <div className="session-title">{meta.title}</div>}
          {meta.subtitle && <div className="muted">{meta.subtitle}</div>}
        </div>
      )}

      {meta.sessionId && <RunningChatBar sessionId={meta.sessionId} />}

      <div className="grid stats">
        <StatTile label="Model" value={meta.model ?? "—"} />
        <StatTile label="Started" value={meta.started ? fmtLocalTsShort(meta.started) : "—"} />
        <StatTile label="Tasks" value={fmtInt(meta.tasks)} />
        <StatTile label="Tools" value={fmtInt(meta.tools)} />
        <StatTile label="Decisions" value={fmtInt(meta.decisions)} />
        <ErrorsStatTile threadId={meta.threadId} errors={meta.errors} />
        <BreakdownStatTile threadId={meta.threadId} sessionId={meta.sessionId} />
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

/** How often to re-ask whether this session's turn is still running. */
const RUNNING_POLL_MS = 3_000;
/** Shared so stopping a turn can invalidate the poll it answers. */
const RUNNING_KEY = ["chat", "running"];

/**
 * Stop, offered from the transcript itself.
 *
 * The tab that started a chat holds the only Stop button in component state, so a
 * navigation — or the Sessions list refreshing under it — takes that button away while
 * the child keeps working. The server still knows the turn is in flight, and a running
 * chat's CLI session id is the same `session:` this transcript records, so this page can
 * recognise itself in that list and stop the turn without the starting tab.
 *
 * Renders nothing at all when this session has no turn running.
 */
function RunningChatBar({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const running = useQuery({
    queryKey: RUNNING_KEY,
    queryFn: getRunningChats,
    refetchInterval: RUNNING_POLL_MS,
  });
  // Re-ask on success rather than waiting out the poll: a bar that lingers after the
  // turn it names has ended reads as a Stop that did not take, and invites a second one.
  const stop = useMutation({
    mutationFn: () => stopChat(sessionId),
    onSuccess: () => client.invalidateQueries({ queryKey: RUNNING_KEY }),
  });
  const chat = running.data?.running.find((r) => r.sessionId === sessionId);
  if (!chat) return null;

  // What it is really running under, which is the answer when a turn is full of denials.
  const permission = chat.effectivePermissionMode ?? chat.permissionMode;
  const drifted = !!chat.effectivePermissionMode && chat.effectivePermissionMode !== chat.permissionMode;

  return (
    <div className="session-running">
      <span className="session-running-dot" aria-hidden="true" />
      <span>
        {chat.mode === "agent" ? "Agent" : "Chat"} turn running since {fmtLocalTsShort(chat.startedAt)}
        {permission && ` · ${permission}`}
      </span>
      {drifted && <span className="session-running-warn">asked for {chat.permissionMode}</span>}
      <button type="button" className="chat-stop" onClick={() => stop.mutate()} disabled={stop.isPending}>
        {stop.isPending ? "Stopping…" : "Stop"}
      </button>
      {stop.error && <span className="session-running-warn">{(stop.error as Error).message}</span>}
    </div>
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

/**
 * Peak-context tile: links to the Request breakdown of this session's largest
 * captured request. Sits idle (muted "—") while the lookup runs, when the
 * transcript carries no session id, or when no sidecar matched it.
 *
 * Requests are matched on the session id, so a transcript without one has no
 * answer to fetch — the query stays disabled rather than round-tripping for a
 * result the server would have to return empty. A failed lookup says so instead
 * of borrowing the empty-result wording, which would blame the data for an
 * outage.
 */
function BreakdownStatTile({ threadId, sessionId }: { threadId: string; sessionId: string | null }) {
  const query = useQuery({
    queryKey: ["session-breakdown", threadId],
    queryFn: () => getSessionBreakdown(threadId),
    enabled: sessionId !== null,
  });
  const peak = query.data?.peak;

  if (!peak) {
    const foot = !sessionId
      ? "no session id"
      : query.isError
        ? "lookup failed"
        : query.isPending
          ? "loading…"
          : "no captured requests";
    return (
      <div className="card stat">
        <div className="stat-label">Peak context</div>
        <div className="stat-value muted">—</div>
        <div className="stat-foot">
          <span className="muted">{foot}</span>
        </div>
      </div>
    );
  }

  const count = query.data?.requestCount ?? 0;
  return (
    <Link to="/context/$file" params={{ file: peak.file }} className="card stat stat-drill">
      <div className="stat-label">Peak context</div>
      <div className="stat-value">{fmtInt(peak.realInput)}</div>
      <div className="stat-foot">
        <span className="stat-drill-cta">request breakdown →</span>
        <span className="muted">
          of {fmtInt(count)} request{count === 1 ? "" : "s"}
        </span>
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
