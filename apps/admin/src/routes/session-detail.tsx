import { useEffect, useState } from "react";
import { sessionName } from "@claude-proxy/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { SessionDetail } from "../api";
import { getRunningChats, getSession, getSessionBreakdown, stopChat } from "../api";
import { useChatSession, useChatThread } from "../chat-session";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { ChatConversation } from "../components/ChatConversation";
import { LiveIndicator } from "../components/LiveIndicator";
import { Markdown } from "../components/Markdown";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt, fmtLocalTsShort } from "../format";
import { useLiveQuery } from "../useLiveQuery";

/**
 * A chat session id, which this route also accepts: a dashboard chat navigates here before its
 * thread id exists, since the proxy fingerprints a thread from the first request over the wire.
 * Thread ids are 16 hex characters, so a uuid is unambiguously the other kind of id.
 */
const CHAT_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SessionDetailPage() {
  const { id } = useParams({ from: "/sessions/$id" });
  const navigate = useNavigate();
  const isChatId = CHAT_SESSION_ID_RE.test(id);

  // Addressed by a chat session id — someone opened this page on purpose. Wait for the transcript
  // the proxy is writing, then replace the URL with the thread id so a reload or a shared link
  // still lands on the transcript.
  const { threadId: resolved, gaveUp } = useChatThread(id, isChatId);
  useEffect(() => {
    if (resolved) navigate({ to: "/sessions/$id", params: { id: resolved }, replace: true });
  }, [resolved, navigate]);

  const query = useQuery({
    queryKey: ["session", id],
    queryFn: () => getSession(id),
    enabled: !isChatId,
  });
  // Stream live appends into the same cache key; the query above is the fallback.
  const live = useLiveQuery(
    `/api/sessions/session/stream?id=${encodeURIComponent(id)}`,
    ["session", id],
    !isChatId,
  );
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
        <h1 className="mono-break">{isChatId ? "New session" : id}</h1>
        {/* The graph is keyed by thread, so a chat id has nothing to link to. */}
        {!isChatId && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Link to="/sessions/graph" search={{ session: id }} className="link">
              live graph →
            </Link>
            <LiveIndicator status={live} />
          </div>
        )}
      </div>

      {isChatId ? (
        <StartingBody sessionId={id} gaveUp={gaveUp} />
      ) : (
        <QueryState isLoading={query.isLoading} error={query.error}>
          {session && <SessionBody session={session} />}
        </QueryState>
      )}
    </section>
  );
}

/** This page before its transcript exists: the chat alone, with the stats and transcript to come. */
function StartingBody({ sessionId, gaveUp }: { sessionId: string; gaveUp: boolean }) {
  return (
    <>
      <SessionChatPanel sessionId={sessionId} />
      <div className="card empty">
        {gaveUp
          ? "No transcript ever arrived for this session — it never reached the proxy, or this id is not one of ours."
          : "Waiting for the proxy to write this session's transcript…"}
      </div>
    </>
  );
}

function SessionBody({ session }: { session: SessionDetail }) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");
  const { meta } = session;
  const name = sessionName(meta);

  return (
    <>
      {(name || meta.subtitle) && (
        <div className="session-heading">
          {name && <div className="session-title">{name}</div>}
          {meta.subtitle && meta.subtitle !== name && <div className="muted">{meta.subtitle}</div>}
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

      {/* Chat — the conversation as it happens; the transcript below lags a turn behind. */}
      {meta.sessionId && <SessionChatPanel sessionId={meta.sessionId} />}

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

/**
 * The live chat for this session, when this session is the one the dashboard started — the turn
 * log, the prompt in flight, the Stop button and an input to carry on. Renders nothing for every
 * other session.
 */
function SessionChatPanel({ sessionId }: { sessionId: string }) {
  const { sessionId: liveId, chat, pendingPrompt, sendError } = useChatSession();
  // `sendError` counts: a failed start has no turn and no reply, and the reason would otherwise
  // be nowhere on screen.
  if (liveId !== sessionId || (!chat && !pendingPrompt && !sendError)) return null;

  const mode = chat?.session.mode ?? "agent";
  return (
    <div className="card chat-starter">
      <div className="card-head">
        <h2>{mode === "agent" ? "Agent" : "Chat"} conversation</h2>
        <span className="muted">started from this dashboard</span>
      </div>
      <ChatConversation placeholder="Reply…" />
    </div>
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
 * Renders nothing at all when this session has no turn running, and nothing when *this* tab is
 * the one running it — the chat panel below already offers that turn's Stop.
 */
function RunningChatBar({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const live = useChatSession();
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
  if (!chat || (live.sessionId === sessionId && live.isSending)) return null;

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
 * captured request. Falls back to a muted "—" naming the state — loading, no
 * session id, lookup failed, or nothing matched.
 *
 * Requests match on the session id, so a transcript without one has nothing to
 * fetch and the query stays disabled.
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
