import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { PermissionMode } from "../api";
import { getChatConfig, getSessions, PERMISSION_MODES } from "../api";
import { useChatSession } from "../chat-session";
import { ChatConversation } from "../components/ChatConversation";
import { LiveIndicator } from "../components/LiveIndicator";
import { QueryState } from "../components/QueryState";
import { SessionsSidenav } from "../components/SessionsSidenav";
import { useLiveQuery } from "../useLiveQuery";

/**
 * Sessions, laid out the way a chat client is: the transcripts as a scrolling rail on
 * the left, and the chat you start from here filling the pane beside it.
 */
export function SessionsPage() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: getSessions });
  // Live: the server re-lists whenever the sessions dir changes; query is the fallback.
  const live = useLiveQuery("/api/sessions/stream", ["sessions"]);
  const { chat, pendingPrompt, reset: newChat } = useChatSession();
  const sessions = query.data?.sessions;

  return (
    <section className="sessions-shell">
      <QueryState isLoading={query.isLoading} error={query.error}>
        <SessionsSidenav
          sessions={sessions ?? []}
          activeId={chat?.session.threadId ?? undefined}
          isDrafting={chat === null && pendingPrompt === null}
          onNewChat={newChat}
        />
      </QueryState>

      <div className="sessions-main">
        <ChatPane sessionsDir={query.data?.meta.sessionsDir} live={live} />
      </div>
    </section>
  );
}

/**
 * The prompt goes to the server's chat route, which sends it through the proxy — so
 * the proxy writes the transcript and the new thread arrives in the rail beside it over
 * SSE, without this page inserting it. The same input then continues the chat.
 */
/** What each standing answer means for the turn. */
const PERMISSION_NOTE: Record<PermissionMode, string> = {
  default: "every gated tool asks — and a headless child can't be asked, so commands are denied",
  acceptEdits: "edits are accepted, but every Bash command is auto-denied — no git writes",
  bypassPermissions: "nothing is asked: commands run, including git writes — what /task needs",
  plan: "read-only — the turn plans and does not act",
};

function ChatPane({
  sessionsDir,
  live,
}: {
  sessionsDir?: string;
  live: ReturnType<typeof useLiveQuery>;
}) {
  const config = useQuery({ queryKey: ["chat", "config"], queryFn: getChatConfig, staleTime: 60_000 });
  const navigate = useNavigate();
  const {
    sessionId,
    chat,
    pendingPrompt,
    isSending,
    permissionMode: pickedPermission,
    setPermissionMode: setPickedPermission,
    reset: newChat,
  } = useChatSession();

  // Once a turn has been handed off the session exists; only the first one starts it.
  const started = chat !== null || pendingPrompt !== null;

  const unconfigured = config.data && !config.data.ready;
  const threadId = chat?.session.threadId;
  const agent = config.data?.agent;
  const permission = (chat?.session.permissionMode ??
    pickedPermission ??
    agent?.permissionMode ??
    "bypassPermissions") as PermissionMode;
  // What the child actually started under, when it differs from what was asked for.
  const drifted =
    !!chat?.session.effectivePermissionMode && chat.session.effectivePermissionMode !== chat.session.permissionMode;

  return (
    <ChatConversation
      fill
      placeholder={started ? "Reply…" : "Ask Claude to do something — /task works here"}
      disabled={!!unconfigured}
      emptyState={<ChatEmptyState />}
      // The first send moves you to the session's own page, where the reply lands.
      onSend={() => {
        if (!started) navigate({ to: "/sessions/$id", params: { id: sessionId } });
      }}
      // The session's own settings, carried in the input the way a chat client does it.
      inputOptions={
        <>
          {/* Locked once a session exists: its posture was fixed when it started. */}
          <select
            className="chat-permission"
            aria-label="Permissions"
            value={permission}
            title={PERMISSION_NOTE[permission]}
            disabled={started || isSending}
            onChange={(e) => setPickedPermission(e.target.value as PermissionMode)}
          >
            {PERMISSION_MODES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {/* The child reports what it started under. Saying so beats inferring the
              answer from a turn full of denials — a server running older code pins
              its own default and the request's choice never lands. */}
          {drifted && (
            <span className="session-running-warn">
              running as {chat?.session.effectivePermissionMode}, not {chat?.session.permissionMode}
            </span>
          )}
        </>
      }
      footnote={
        <>
          <span>
            {config.data
              ? `${config.data.model} · through ${config.data.baseUrl} · ${
                  config.data.transport === "cli" ? "headless Claude Code" : "API key"
                }`
              : config.error
                ? (config.error as Error).message
                : "resolving chat config…"}
          </span>
          {sessionsDir && <span className="mono-break">logs → {sessionsDir}</span>}
          {unconfigured && <span className="error">Chat is unavailable: {config.data?.readyHint}</span>}
          <LiveIndicator status={live} />
        </>
      }
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
  );
}

/** The blank pane before the first turn, centered on the one thing to do with it. */
function ChatEmptyState() {
  return (
    <div className="chat-empty">
      <span className="chat-empty-node" aria-hidden />
      <h2>Start an agent session</h2>
      <p className="muted">
        It runs with tools and writes a transcript the proxy captures — it appears in the rail as it goes.
      </p>
    </div>
  );
}
