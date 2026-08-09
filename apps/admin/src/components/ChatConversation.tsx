import { type ReactNode, useEffect, useRef } from 'react';
import type { ChatInterruption, ChatToolUse } from '../api';
import { useChatSession } from '../chat-session';
import { fmtInt } from '../format';
import type { LiveTurn } from '../useChatStream';
import { Markdown } from './Markdown';
import { PromptInput } from './PromptInput';

/** Why a turn ended early, in the terms that tell you what to do about it. */
const INTERRUPTION_NOTE: Record<ChatInterruption, string> = {
  stopped: 'Turn stopped',
  timeout: 'Turn went quiet and was ended',
  limit: 'Turn hit the time limit for one turn',
};

/**
 * The live chat: what was asked, what came back, what the turn ran, and the input to keep going.
 * Shared by the Sessions page's chat pane and the session page.
 *
 * Laid out as a scrolling transcript above a pinned composer.
 *
 * The prompt in flight renders as a user turn straight away — the server returns history only
 * once the turn resolves, and an agent turn can run for an hour.
 */
export function ChatConversation({
  placeholder,
  disabled = false,
  fill = false,
  emptyState,
  inputOptions,
  footnote,
  footExtras,
}: {
  placeholder: string;
  disabled?: boolean;
  /** Stretch to the container's height instead of growing with the turns. */
  fill?: boolean;
  /** Shown in place of the transcript before the first turn. */
  emptyState?: ReactNode;
  /** The session's settings, carried inside the input's own toolbar. */
  inputOptions?: ReactNode;
  /** The fine print under the composer — where this chat runs and where its transcript lands. */
  footnote?: ReactNode;
  /** Page-specific foot controls — the transcript link and "New chat" on the Sessions page. */
  footExtras?: ReactNode;
}) {
  // The draft lives in the session, not here: this component unmounts on every navigation.
  const { chat, pendingPrompt, live, isSending, sendError, isStopping, stopError, draft, setDraft, send, stop } =
    useChatSession();
  const log = useRef<HTMLDivElement>(null);
  const started = !!chat || !!pendingPrompt;

  // Follow the transcript down as turns land — and as the turn in flight grows, since a
  // streamed reply lengthens the log without any turn having landed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads a ref, so these are here purely to re-scroll when a turn, a pending prompt or another slice of the streamed reply lands
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, pendingPrompt, live.text, live.tools.length]);

  return (
    <div className={`chat-panel${fill ? ' chat-panel--fill' : ''}`}>
      {started ? (
        <div className='chat-log' ref={log}>
          {chat?.turns.map((turn, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: turns are only ever appended, so the index is stable
            <ChatBubble key={i} role={turn.role}>
              {turn.role === 'assistant' ? <Markdown source={turn.text} /> : <p>{turn.text}</p>}
            </ChatBubble>
          ))}
          {pendingPrompt && (
            <>
              {/* biome-ignore lint/a11y/useValidAriaRole: `role` is ChatBubble's own prop (user | assistant), not an ARIA role */}
              <ChatBubble role='user'>
                <p>{pendingPrompt}</p>
              </ChatBubble>
              {/* biome-ignore lint/a11y/useValidAriaRole: `role` is ChatBubble's own prop (user | assistant), not an ARIA role */}
              <ChatBubble role='assistant'>
                <StreamingReply live={live} />
              </ChatBubble>
            </>
          )}
        </div>
      ) : (
        emptyState && <div className='chat-log chat-log--empty'>{emptyState}</div>
      )}

      <div className='chat-composer'>
        {/* A cut-short turn's partial reply, labelled so it doesn't read as the answer. */}
        {chat?.interrupted && (
          <p className='muted chat-note'>
            {INTERRUPTION_NOTE[chat.interrupted]} — this is what arrived before it ended.
          </p>
        )}

        {/* Tools the turn ran — agent turns only. Hidden while a turn is in flight, because
            the bubble above is carrying that turn's chips live and these are the previous
            turn's; two rows of chips at once would read as one list. */}
        {!pendingPrompt && chat && chat.tools.length > 0 && (
          <div className='chat-tools'>
            <span className='muted'>ran</span>
            {chat.tools.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the tool list is append-only for the life of the turn
              <ToolChip key={i} tool={t} />
            ))}
          </div>
        )}

        {footnote && <div className='muted chat-footnote'>{footnote}</div>}

        <PromptInput
          value={draft}
          onValueChange={setDraft}
          onSubmit={send}
          placeholder={placeholder}
          disabled={disabled}
          status={isSending ? 'submitted' : sendError ? 'error' : 'ready'}
          options={inputOptions}
        />

        <div className='chat-foot'>
          {sendError && <span className='error'>{sendError.message}</span>}
          {stopError && <span className='error'>{stopError.message}</span>}
          {isSending && (
            <button type='button' className='chat-stop' onClick={stop} disabled={isStopping}>
              {isStopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {chat && (
            <span className='muted'>
              {fmtInt(chat.usage.input + chat.usage.cacheRead + chat.usage.cacheCreation)} in ·{' '}
              {fmtInt(chat.usage.output)} out
            </span>
          )}
          {footExtras}
        </div>
      </div>
    </div>
  );
}

/** One turn: an avatar beside the message, the reader's own turns mirrored to the right. */
function ChatBubble({ role, children }: { role: 'user' | 'assistant'; children: ReactNode }) {
  return (
    <div className={`chat-turn ${role}`}>
      <span className='chat-avatar' aria-hidden>
        {role === 'user' ? 'You' : 'C'}
      </span>
      <div className='chat-bubble'>{children}</div>
    </div>
  );
}

/** One tool the turn ran; a failure carries the first line of its `tool_result` text. */
function ToolChip({ tool, running = false }: { tool: ChatToolUse; running?: boolean }) {
  const reason = tool.failed ? tool.error?.split('\n')[0]?.trim() : undefined;
  return (
    <span className={`chat-tool${tool.failed ? ' is-failed' : ''}${running ? ' is-running' : ''}`} title={tool.error}>
      {tool.name}
      {tool.failed ? ' ✗' : ''}
      {reason && <span className='chat-tool-why'>{reason}</span>}
    </span>
  );
}

/**
 * The turn in flight, as it happens: the reply's text so far and the tools beside it in the
 * order the turn ran them.
 *
 * **This bubble is provisional.** Nothing here is the record of the turn — when the POST
 * resolves, `chat.turns` replaces the whole thing with the finished text, which is also what
 * a dropped stream falls back to. So it renders the three-dot wait until the first slice
 * lands, and a stream that never connects looks exactly like the wait it replaced.
 *
 * Announced rather than read out. The `role='status'` region the old wait span carried moves
 * here, but it carries a short sentence instead of the reply: a live region over streaming
 * prose re-announces half-written markdown on every append, which is noise rather than
 * access. The visible stream is `aria-hidden`, and the finished bubble underneath it is the
 * artifact a screen reader reads.
 */
function StreamingReply({ live }: { live: LiveTurn }) {
  const running = live.tools.some((t) => !t.done);
  const announcement = !live.streaming
    ? 'Working'
    : live.tools.length === 0
      ? 'Reply arriving'
      : `Reply arriving — ${fmtInt(live.tools.length)} ${live.tools.length === 1 ? 'tool' : 'tools'} run so far`;

  return (
    <div className='chat-live'>
      <span className='sr-only' role='status'>
        {announcement}
      </span>

      <div aria-hidden>
        {live.text ? (
          <div className={`chat-live-text${running ? '' : ' is-typing'}`}>
            {live.truncated && (
              <p className='muted chat-note'>…earlier of this reply not shown; it lands in full below.</p>
            )}
            <Markdown source={live.text} />
          </div>
        ) : (
          <span className='chat-thinking'>
            <i />
            <i />
            <i />
          </span>
        )}

        {live.tools.length > 0 && (
          <div className='chat-tools chat-tools--live'>
            {live.tools.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the index is the turn's own tool ordinal, which is what the server streams and never reorders
              <ToolChip key={i} tool={t} running={!t.done} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
