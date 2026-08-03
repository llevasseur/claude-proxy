import { type ReactNode, useEffect, useRef } from 'react';
import type { ChatInterruption, ChatToolUse } from '../api';
import { useChatSession } from '../chat-session';
import { fmtInt } from '../format';
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
  const { chat, pendingPrompt, isSending, sendError, isStopping, stopError, draft, setDraft, send, stop } =
    useChatSession();
  const log = useRef<HTMLDivElement>(null);
  const started = !!chat || !!pendingPrompt;

  // Follow the transcript down as turns land.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads a ref, so these are here purely to re-scroll when a turn or a pending prompt lands
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, pendingPrompt]);

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
                <span className='chat-thinking' role='status' aria-label='Working'>
                  <i />
                  <i />
                  <i />
                </span>
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

        {/* Tools the turn ran — agent turns only. */}
        {chat && chat.tools.length > 0 && (
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
function ToolChip({ tool }: { tool: ChatToolUse }) {
  const reason = tool.failed ? tool.error?.split('\n')[0]?.trim() : undefined;
  return (
    <span className={`chat-tool${tool.failed ? ' is-failed' : ''}`} title={tool.error}>
      {tool.name}
      {tool.failed ? ' ✗' : ''}
      {reason && <span className='chat-tool-why'>{reason}</span>}
    </span>
  );
}
