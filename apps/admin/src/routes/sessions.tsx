import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ChatMode, ChatSendResponse, ChatToolUse, PermissionMode, SessionSummary } from "../api";
import { endChat, getChatConfig, getSessions, PERMISSION_MODES, sendChatMessage, startChat, stopChat } from "../api";
import { LiveIndicator } from "../components/LiveIndicator";
import { Markdown } from "../components/Markdown";
import { PromptInput } from "../components/PromptInput";
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
/** What each standing answer means for the turn, in the one line the form has room for. */
const PERMISSION_NOTE: Record<PermissionMode, string> = {
  default: "every gated tool asks — and a headless child can't be asked, so commands are denied",
  acceptEdits: "edits are accepted, but every Bash command is auto-denied — no git writes",
  bypassPermissions: "nothing is asked: commands run, including git writes — what /task needs",
  plan: "read-only — the turn plans and does not act",
};

function StartChatCard() {
  const config = useQuery({ queryKey: ["chat", "config"], queryFn: getChatConfig, staleTime: 60_000 });
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const [chat, setChat] = useState<ChatSendResponse | null>(null);
  // null → follow whatever the server defaults to.
  const [picked, setPicked] = useState<ChatMode | null>(null);
  const [pickedPermission, setPickedPermission] = useState<PermissionMode | null>(null);
  // Named here, before the first turn, so Stop has a handle on it while it runs.
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());

  const send = useMutation({
    mutationFn: (prompt: string) =>
      chat
        ? sendChatMessage(sessionId, prompt)
        : startChat(sessionId, prompt, { mode: picked ?? undefined, permissionMode: pickedPermission ?? undefined }),
    onSuccess: (data) => {
      setChat(data);
      setDraft("");
      // Refresh the list behind the live stream: the transcript is new, or it grew.
      client.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  // Stopping doesn't fail the send: the turn resolves with whatever it had reached.
  const stop = useMutation({ mutationFn: () => stopChat(sessionId) });

  /** Drop the server's copy too, so its session map doesn't grow a tab at a time. */
  const newChat = () => {
    endChat(sessionId).catch(() => {
      /* best-effort: a session it has already forgotten is the outcome we wanted */
    });
    setSessionId(crypto.randomUUID());
    setChat(null);
    // Both mutations too: a failed turn's error otherwise sits under the new empty chat.
    send.reset();
    stop.reset();
  };

  const unconfigured = config.data && !config.data.ready;
  const threadId = chat?.session.threadId;
  // A running chat's mode is fixed server-side, so it wins over the picker.
  const mode: ChatMode = chat?.session.mode ?? picked ?? config.data?.mode ?? "agent";
  const agent = config.data?.agent;
  const permission = (chat?.session.permissionMode ??
    pickedPermission ??
    agent?.permissionMode ??
    "acceptEdits") as PermissionMode;

  return (
    <div className="card chat-starter">
      <div className="card-head">
        <h2>{chat ? `${mode === "agent" ? "Agent" : "Chat"} in progress` : "Start a session"}</h2>
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
            disabled={!!chat || send.isPending}
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

      {/* Per session, and pinned like the mode — the alternative is an env var and a restart. */}
      {mode === "agent" && (
        <div className="chat-modes">
          <label className="muted chat-mode-note" htmlFor="chat-permission">
            permissions
          </label>
          <select
            id="chat-permission"
            className="chat-permission"
            value={permission}
            disabled={!!chat || send.isPending}
            onChange={(e) => setPickedPermission(e.target.value as PermissionMode)}
          >
            {PERMISSION_MODES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="muted chat-mode-note">{PERMISSION_NOTE[permission]}</span>
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

      {chat && (
        <div className="chat-log">
          {chat.turns.map((turn, i) => (
            <div key={i} className={`chat-turn ${turn.role}`}>
              <span className="chat-role">{turn.role === "user" ? "You" : "Claude"}</span>
              {turn.role === "assistant" ? <Markdown source={turn.text} /> : <p>{turn.text}</p>}
            </div>
          ))}
        </div>
      )}

      {/* A cut-short turn still says what it managed, so label it rather than let it read as the answer. */}
      {chat?.interrupted && (
        <p className="muted chat-note">
          {chat.interrupted === "timeout" ? "Turn timed out" : "Turn stopped"} — this is what arrived before it ended.
        </p>
      )}

      {/* What the turn did, not just what it said — agent turns only. */}
      {chat && chat.tools.length > 0 && (
        <div className="chat-tools">
          <span className="muted">ran</span>
          {chat.tools.map((t, i) => (
            <ToolChip key={i} tool={t} />
          ))}
        </div>
      )}

      <PromptInput
        value={draft}
        onValueChange={setDraft}
        onSubmit={(prompt) => send.mutate(prompt)}
        placeholder={
          chat ? "Reply…" : mode === "agent" ? "Ask Claude to do something — /task works here" : "Ask Claude something — this starts a new session"
        }
        disabled={!!unconfigured}
        status={send.isPending ? "submitted" : send.isError ? "error" : "ready"}
      />

      <div className="chat-foot">
        {send.isError && <span className="error">{(send.error as Error).message}</span>}
        {stop.isError && <span className="error">{(stop.error as Error).message}</span>}
        {/* An agent turn can run for minutes; this is the only way to take it back. */}
        {send.isPending && (
          <button type="button" className="chat-stop" onClick={() => stop.mutate()} disabled={stop.isPending}>
            {stop.isPending ? "Stopping…" : "Stop"}
          </button>
        )}
        {chat && (
          <>
            {threadId && (
              <Link to="/sessions/$id" params={{ id: threadId }} className="link mono-break">
                open transcript {threadId}
              </Link>
            )}
            <span className="muted">
              {fmtInt(chat.usage.input + chat.usage.cacheRead + chat.usage.cacheCreation)} in ·{" "}
              {fmtInt(chat.usage.output)} out
            </span>
            <button type="button" className="chat-new" onClick={newChat} disabled={send.isPending}>
              New chat
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One tool the turn ran. A failure carries its `tool_result` text, because "Bash ✗"
 * alone reads as a broken tool when it is usually the permission mode declining it.
 */
function ToolChip({ tool }: { tool: ChatToolUse }) {
  const reason = tool.failed ? tool.error?.split("\n")[0]?.trim() : undefined;
  return (
    <span className={`chat-tool${tool.failed ? " is-failed" : ""}`} title={tool.error}>
      {tool.name}
      {tool.failed ? " ✗" : ""}
      {reason && <span className="chat-tool-why">{reason}</span>}
    </span>
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
                {s.title ? (
                  <>
                    <div className="session-title">{s.title}</div>
                    <Link
                      to="/sessions/$id"
                      params={{ id: s.threadId }}
                      className="link mono-break session-id"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {s.threadId}
                    </Link>
                  </>
                ) : (
                  <Link
                    to="/sessions/$id"
                    params={{ id: s.threadId }}
                    className="link mono-break"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.threadId}
                  </Link>
                )}
                {(s.subtitle ?? s.firstTask) && (
                  <div className="muted session-preview">{s.subtitle ?? s.firstTask}</div>
                )}
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
