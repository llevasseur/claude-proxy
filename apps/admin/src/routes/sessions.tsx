import { useQuery } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import type { PermissionMode } from '../api';
import { getChatConfig, getSessions, PERMISSION_MODES } from '../api';
import { useChatSession, useChatThread } from '../chat-session';
import { ChatConversation } from '../components/ChatConversation';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import { SessionsSidenav } from '../components/SessionsSidenav';
import { Skeleton } from '../components/Skeleton';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import type { NavEntry } from './nav';

/**
 * Sessions, laid out the way a chat client is: the transcripts as a scrolling rail on
 * the left, and the chat you start from here filling the pane beside it.
 *
 * Sending and replying both happen here — the page never follows the session onto its own
 * transcript page. The rail marks it instead, and the transcript is a link away.
 */
export function SessionsPage() {
  const query = useQuery({ queryKey: ['sessions'], queryFn: getSessions });
  // Live: the server re-lists whenever the sessions dir changes; query is the fallback.
  const live = useLiveQuery('/api/sessions/stream', ['sessions']);
  const { sessionId, chat, pendingPrompt, reset: newChat } = useChatSession();
  const sessions = query.data?.sessions;

  const started = chat !== null || pendingPrompt !== null;
  // The reply carries the thread id, but a turn can run for an hour — ask the proxy directly so
  // the rail can mark the session mid-turn.
  const { threadId: resolved } = useChatThread(sessionId, started && !chat?.session.threadId);
  const threadId = chat?.session.threadId ?? resolved ?? undefined;

  return (
    <section className='sessions-shell'>
      {/* The rail is the only half that waits; the chat beside it is usable from the
          first paint, in a grid column the shell already sizes. */}
      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<SessionsRailSkeleton />}>
        <SessionsSidenav sessions={sessions ?? []} activeId={threadId} isDrafting={!started} onNewChat={newChat} />
      </QueryState>

      <div className='sessions-main'>
        <ChatPane sessionsDir={query.data?.meta.sessionsDir} live={live} threadId={threadId} />
      </div>
    </section>
  );
}

/** The transcript rail, shaped like the rows `SessionsSidenav` fills it with. */
function SessionsRailSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <aside className='sessions-nav' aria-hidden>
      <div className='sessions-nav-body'>
        <div className='sessions-nav-list'>
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
            <div className='session-row-link' key={i}>
              <div className='session-row-top'>
                <span className='session-row-name'>
                  <Skeleton w={`${72 - (i % 3) * 12}%`} />
                </span>
                <span className='session-row-age'>
                  <Skeleton w='2.5rem' />
                </span>
              </div>
              <span className='session-row-preview'>
                <Skeleton w='88%' />
              </span>
              <div className='session-row-meta'>
                <Skeleton w='4rem' />
                <Skeleton w='3.5rem' />
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

/**
 * The prompt goes to the server's chat route, which sends it through the proxy — so
 * the proxy writes the transcript and the new thread arrives in the rail beside it over
 * SSE, without this page inserting it. The same input then continues the chat.
 */
/** What each standing answer means for the turn. */
const PERMISSION_NOTE = {
  default: "every gated tool asks — and a headless child can't be asked, so commands are denied",
  acceptEdits: 'edits are accepted, but every Bash command is auto-denied — no git writes',
  bypassPermissions: 'nothing is asked: commands run, including git writes — what /task needs',
  plan: 'read-only — the turn plans and does not act',
} as const satisfies Record<PermissionMode, string>;

/**
 * The session and the agent config both report their posture as a plain string, since a
 * server on older code may name a mode this build has never heard of. This is where such
 * a mode is turned back into a choice the picker and `PERMISSION_NOTE` can both answer for.
 */
function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}

function ChatPane({
  sessionsDir,
  live,
  threadId,
}: {
  sessionsDir?: string;
  live: ReturnType<typeof useLiveQuery>;
  /** The transcript this chat became, once the proxy has written it. */
  threadId?: string;
}) {
  const config = useQuery({ queryKey: ['chat', 'config'], queryFn: getChatConfig, staleTime: 60_000 });
  const {
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
  const agent = config.data?.agent;
  const asked = chat?.session.permissionMode ?? pickedPermission ?? agent?.permissionMode;
  const permission = asked && isPermissionMode(asked) ? asked : 'bypassPermissions';
  // What the child actually started under, when it differs from what was asked for.
  const drifted =
    !!chat?.session.effectivePermissionMode && chat.session.effectivePermissionMode !== chat.session.permissionMode;

  return (
    <ChatConversation
      fill
      placeholder={started ? 'Reply…' : 'Ask Claude to do something — /task works here'}
      disabled={!!unconfigured}
      emptyState={<ChatEmptyState />}
      // The session's own settings, carried in the input's toolbar.
      inputOptions={
        <>
          {/* Locked once a session exists: its posture was fixed when it started.
              The `.select-field` wrapper is what draws the disclosure arrow. */}
          <div className='select-field chat-permission'>
            <select
              aria-label='Permissions'
              value={permission}
              title={PERMISSION_NOTE[permission]}
              disabled={started || isSending}
              onChange={(e) => {
                if (isPermissionMode(e.target.value)) setPickedPermission(e.target.value);
              }}>
              {PERMISSION_MODES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          {/* The child reports what it started under. Saying so beats inferring the
              answer from a turn full of denials — a server running older code pins
              its own default and the request's choice never lands. */}
          {drifted && (
            <span className='session-running-warn'>
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
                  config.data.transport === 'cli' ? 'headless Claude Code' : 'API key'
                }`
              : config.error
                ? config.error.message
                : 'resolving chat config…'}
          </span>
          {sessionsDir && <span className='mono-break'>logs → {sessionsDir}</span>}
          {unconfigured && <span className='error'>Chat is unavailable: {config.data?.readyHint}</span>}
          <LiveIndicator status={live} />
        </>
      }
      footExtras={
        started && (
          <>
            {threadId && (
              <Link to='/sessions/$id' params={{ id: threadId }} className='link mono-break'>
                open transcript {threadId}
              </Link>
            )}
            <button type='button' className='chat-new' onClick={newChat} disabled={isSending}>
              New chat
            </button>
          </>
        )
      }
    />
  );
}

/** The blank pane before the first turn. */
function ChatEmptyState() {
  return (
    <div className='chat-empty'>
      <span className='chat-empty-node' aria-hidden />
      <h2>Start an agent session</h2>
      <p className='muted'>
        It runs with tools and writes a transcript the proxy captures — it appears in the rail as it goes.
      </p>
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsPage,
  staticData: { title: 'Sessions' },
});

export const nav = {
  section: 'Sessions',
  to: '/sessions',
  label: 'Sessions',
  hint: 'transcripts',
  exact: true,
  icon: MessagesSquare,
} as const satisfies NavEntry;
