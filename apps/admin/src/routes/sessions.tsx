import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ChatSendResponse, SessionSummary } from "../api";
import { getChatConfig, getSessions, sendChatMessage, startChat } from "../api";
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
function StartChatCard() {
  const config = useQuery({ queryKey: ["chat", "config"], queryFn: getChatConfig, staleTime: 60_000 });
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const [chat, setChat] = useState<ChatSendResponse | null>(null);

  const send = useMutation({
    mutationFn: (prompt: string) =>
      chat ? sendChatMessage(chat.session.id, prompt) : startChat(prompt),
    onSuccess: (data) => {
      setChat(data);
      setDraft("");
      // Refresh the list behind the live stream: the transcript is new, or it grew.
      client.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const unconfigured = config.data && !config.data.apiKeySet;
  const threadId = chat?.session.threadId;

  return (
    <div className="card chat-starter">
      <div className="card-head">
        <h2>{chat ? "Chat in progress" : "Start a session"}</h2>
        <span className="muted">
          {config.data
            ? `${config.data.model} · through ${config.data.baseUrl}`
            : config.error
              ? (config.error as Error).message
              : "resolving chat config…"}
        </span>
      </div>

      {unconfigured && (
        <p className="muted chat-note">
          Chat needs <code>ANTHROPIC_API_KEY</code> in the server's environment. The proxy forwards
          credentials, it never supplies them.
        </p>
      )}

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

      <PromptInput
        value={draft}
        onValueChange={setDraft}
        onSubmit={(prompt) => send.mutate(prompt)}
        placeholder={chat ? "Reply…" : "Ask Claude something — this starts a new session"}
        disabled={!!unconfigured}
        status={send.isPending ? "submitted" : send.isError ? "error" : "ready"}
      />

      <div className="chat-foot">
        {send.isError && <span className="error">{(send.error as Error).message}</span>}
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
            <button type="button" className="chat-new" onClick={() => setChat(null)} disabled={send.isPending}>
              New chat
            </button>
          </>
        )}
      </div>
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
