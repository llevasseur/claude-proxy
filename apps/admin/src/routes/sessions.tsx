import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ChatMode, PermissionMode } from "../api";
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
    <>
      <header className="chat-head">
        <div className="chat-head-title">
          <h1>{started ? `${mode === "agent" ? "Agent" : "Chat"} in progress` : "Start a session"}</h1>
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
        <LiveIndicator status={live} />
      </header>

      <div className="chat-settings">
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
      </div>

      <ChatConversation
        fill
        placeholder={
          started
            ? "Reply…"
            : mode === "agent"
              ? "Ask Claude to do something — /task works here"
              : "Ask Claude something — this starts a new session"
        }
        disabled={!!unconfigured}
        emptyState={<ChatEmptyState mode={mode} sessionsDir={sessionsDir} />}
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
    </>
  );
}

/** The blank pane before the first turn — what this chat is, and where its transcript lands. */
function ChatEmptyState({ mode, sessionsDir }: { mode: ChatMode; sessionsDir?: string }) {
  return (
    <div className="chat-empty">
      <span className="chat-empty-node" aria-hidden />
      <h2>{mode === "agent" ? "Start an agent session" : "Start a chat"}</h2>
      <p className="muted">
        {mode === "agent"
          ? "It runs with tools and writes a transcript the proxy captures — it appears in the rail as it goes."
          : "A plain conversation, no tools. The proxy still captures the transcript."}
      </p>
      {sessionsDir && <p className="muted mono-break chat-empty-dir">{sessionsDir}</p>}
    </div>
  );
}
