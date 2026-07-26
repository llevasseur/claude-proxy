import { sessionName } from "@claude-proxy/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ChatMode, PermissionMode, SessionSummary } from "../api";
import { getChatConfig, getSessions, PERMISSION_MODES } from "../api";
import { useChatSession } from "../chat-session";
import { ChatConversation } from "../components/ChatConversation";
import { LiveIndicator } from "../components/LiveIndicator";
import { QueryState } from "../components/QueryState";
import { fmtInt, fmtLocalTsShort } from "../format";
import { useLiveQuery } from "../useLiveQuery";

export function SessionsPage() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: getSessions });
  // Live: the server re-lists whenever the sessions dir changes; query is the fallback.
  const live = useLiveQuery("/api/sessions/stream", ["sessions"]);
  const sessions = query.data?.sessions;

  return (
    <section>
      <div className="pagehead">
        <h1>Sessions</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="muted">Append-only agent transcripts the proxy captured</span>
          <LiveIndicator status={live} />
        </div>
      </div>

      <StartChatCard />

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!sessions || sessions.length === 0 ? (
          <div className="card empty">No session transcripts yet.</div>
        ) : (
          <>
            <div className="muted mono-break" style={{ marginBottom: "0.75rem" }}>
              {query.data?.meta.sessionsDir}
            </div>
            <SessionsTable sessions={sessions} />
          </>
        )}
      </QueryState>
    </section>
  );
}

/**
 * The prompt goes to the server's chat route, which sends it through the proxy — so
 * the proxy writes the transcript and the new thread arrives in the table below over
 * SSE, without this page inserting it. The same input then continues the chat.
 */
/** What each standing answer means for the turn. */
const PERMISSION_NOTE: Record<PermissionMode, string> = {
  default: "every gated tool asks — and a headless child can't be asked, so commands are denied",
  acceptEdits: "edits are accepted, but every Bash command is auto-denied — no git writes",
  bypassPermissions: "nothing is asked: commands run, including git writes — what /task needs",
  plan: "read-only — the turn plans and does not act",
};

function StartChatCard() {
  const config = useQuery({ queryKey: ["chat", "config"], queryFn: getChatConfig, staleTime: 60_000 });
  const navigate = useNavigate();
  const {
    sessionId,
    chat,
    pendingPrompt,
    isSending,
    mode: picked,
    permissionMode: pickedPermission,
    setMode: setPicked,
    setPermissionMode: setPickedPermission,
    reset: newChat,
  } = useChatSession();

  // Once a turn has been handed off the session exists; only the first one starts it.
  const started = chat !== null || pendingPrompt !== null;

  const unconfigured = config.data && !config.data.ready;
  const threadId = chat?.session.threadId;
  // A running chat's mode is fixed server-side, so it wins over the picker.
  const mode: ChatMode = chat?.session.mode ?? picked ?? config.data?.mode ?? "agent";
  const agent = config.data?.agent;
  const permission = (chat?.session.permissionMode ??
    pickedPermission ??
    agent?.permissionMode ??
    "bypassPermissions") as PermissionMode;
  // What the child actually started under, when it differs from what was asked for.
  const drifted =
    !!chat?.session.effectivePermissionMode && chat.session.effectivePermissionMode !== chat.session.permissionMode;

  return (
    <div className="card chat-starter">
      <div className="card-head">
        <h2>{started ? `${mode === "agent" ? "Agent" : "Chat"} in progress` : "Start a session"}</h2>
        <span className="muted">
          {config.data
            ? `${config.data.model} · through ${config.data.baseUrl} · ${
                config.data.transport === "cli" ? "headless Claude Code" : "API key"
              }`
            : config.error
              ? (config.error as Error).message
              : "resolving chat config…"}
        </span>
      </div>

      {/* Locked once a session exists: its posture was fixed when it started. */}
      <div className="chat-modes" role="group" aria-label="Session mode">
        {(["agent", "chat"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`chat-mode${mode === m ? " is-active" : ""}`}
            aria-pressed={mode === m}
            disabled={started || isSending}
            onClick={() => setPicked(m)}
          >
            {m === "agent" ? "Agent" : "Chat"}
          </button>
        ))}
        <span className="muted chat-mode-note">
          {mode === "agent"
            ? agent
              ? `runs in ${agent.cwd} with tools — this can change the repo`
              : "runs a full Claude Code session with tools"
            : "no tools, no customizations — cannot touch the repo"}
        </span>
      </div>

      {/* Permissions — per session, and pinned like the mode. */}
      {mode === "agent" && (
        <div className="chat-modes">
          <label className="muted chat-mode-note" htmlFor="chat-permission">
            permissions
          </label>
          <select
            id="chat-permission"
            className="chat-permission"
            value={permission}
            disabled={started || isSending}
            onChange={(e) => setPickedPermission(e.target.value as PermissionMode)}
          >
            {PERMISSION_MODES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="muted chat-mode-note">{PERMISSION_NOTE[permission]}</span>
          {/* The child reports what it started under. Saying so beats inferring the
              answer from a turn full of denials — a server running older code pins
              its own default and the request's choice never lands. */}
          {drifted && (
            <span className="session-running-warn">
              running as {chat?.session.effectivePermissionMode}, not {chat?.session.permissionMode}
            </span>
          )}
        </div>
      )}

      {mode === "agent" && agent && (
        <p className="muted chat-note">
          {agent.aliasFound
            ? `Mirroring your \`${agent.alias}\` alias${
                agent.flags.disallowedTools.length ? ` (withholding ${agent.flags.disallowedTools.join(", ")})` : ""
              }`
            : `No \`${agent.alias}\` alias in ${agent.rcPath} — running a bare claude`}
        </p>
      )}

      {unconfigured && <p className="muted chat-note">Chat is unavailable: {config.data?.readyHint}</p>}

      <ChatConversation
        placeholder={
          started
            ? "Reply…"
            : mode === "agent"
              ? "Ask Claude to do something — /task works here"
              : "Ask Claude something — this starts a new session"
        }
        disabled={!!unconfigured}
        // The first send moves you to the session's own page, where the reply lands.
        onSend={() => {
          if (!started) navigate({ to: "/sessions/$id", params: { id: sessionId } });
        }}
        footExtras={
          chat && (
            <>
              {threadId && (
                <Link to="/sessions/$id" params={{ id: threadId }} className="link mono-break">
                  open transcript {threadId}
                </Link>
              )}
              <button type="button" className="chat-new" onClick={newChat} disabled={isSending}>
                New chat
              </button>
            </>
          )
        }
      />
    </div>
  );
}

type SortKey = "threadId" | "model" | "tasks" | "tools" | "errors" | "modified";
type SortDir = "asc" | "desc";

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  threadId: "asc",
  model: "asc",
  tasks: "desc",
  tools: "desc",
  errors: "desc",
  modified: "desc",
};

/** Signed comparison for a column, ascending. */
function compare(a: SessionSummary, b: SessionSummary, key: SortKey): number {
  switch (key) {
    case "threadId":
      return a.threadId.localeCompare(b.threadId);
    case "model":
      return (a.model ?? "").localeCompare(b.model ?? "");
    case "modified":
      return a.modified.localeCompare(b.modified);
    default:
      return a[key] - b[key];
  }
}

function SessionsTable({ sessions }: { sessions: SessionSummary[] }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "modified", dir: "desc" });

  const sorted = useMemo(() => {
    const rows = [...sessions];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === "asc" ? diff : -diff;
    });
    return rows;
  }, [sessions, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </h2>
        <span className="muted">click a column to sort · click a row to read the transcript</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <SortHeader label="Session" sortKey="threadId" sort={sort} onSort={onSort} />
            <SortHeader label="Model" sortKey="model" sort={sort} onSort={onSort} />
            <SortHeader label="Tasks" sortKey="tasks" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Tools" sortKey="tools" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Errors" sortKey="errors" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Updated" sortKey="modified" sort={sort} onSort={onSort} className="num" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr
              key={s.threadId}
              className="clickable"
              onClick={() => navigate({ to: "/sessions/$id", params: { id: s.threadId } })}
            >
              <td>
                <SessionCell session={s} />
              </td>
              <td className="mono-break">{s.model ?? "—"}</td>
              <td className="num">{fmtInt(s.tasks)}</td>
              <td className="num">{fmtInt(s.tools)}</td>
              <td className="num">
                {s.errors > 0 ? (
                  <Link
                    to="/sessions/$id/errors"
                    params={{ id: s.threadId }}
                    className="error error-count"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {fmtInt(s.errors)}
                  </Link>
                ) : (
                  <span className="muted">0</span>
                )}
              </td>
              <td className="num muted">{fmtLocalTsShort(s.modified)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A row's name: whatever the transcript calls itself, headlined, with the thread id
 * kept underneath as the mono link to copy or open. Only a transcript that offers no
 * name at all — no title, no derived name, no opening prompt — leads with its id.
 */
function SessionCell({ session }: { session: SessionSummary }) {
  const name = sessionName(session);
  const preview = session.subtitle ?? session.firstTask;
  const idLink = (
    <Link
      to="/sessions/$id"
      params={{ id: session.threadId }}
      className={`link mono-break${name ? " session-id" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      {session.threadId}
    </Link>
  );

  return (
    <>
      {name && <div className="session-title">{name}</div>}
      {idLink}
      {/* The preview is the prompt in full; skip it when the name already is that prompt. */}
      {preview && preview !== name && <div className="muted session-preview">{preview}</div>}
    </>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={["sortable", className].filter(Boolean).join(" ")}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && <span className="sort-arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}
