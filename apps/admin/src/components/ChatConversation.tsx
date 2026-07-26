import { useState, type ReactNode } from "react";
import type { ChatInterruption, ChatToolUse } from "../api";
import { useChatSession } from "../chat-session";
import { fmtInt } from "../format";
import { Markdown } from "./Markdown";
import { PromptInput } from "./PromptInput";

/** Why a turn ended early, in the terms that tell you what to do about it. */
const INTERRUPTION_NOTE: Record<ChatInterruption, string> = {
  stopped: "Turn stopped",
  timeout: "Turn went quiet and was ended",
  limit: "Turn hit the time limit for one turn",
};

/**
 * The live chat itself: what was asked, what came back, what the turn ran, and the input
 * to keep going. Rendered both on the Sessions page's start card and on the session page
 * the chat navigates to, so the conversation reads the same in either place.
 *
 * The prompt in flight is rendered as a user turn straight away. The server only returns
 * history once the turn resolves, and an agent turn can run for an hour — without this the
 * page you were just navigated to would sit empty with nothing saying what it is working on.
 */
export function ChatConversation({
  placeholder,
  disabled = false,
  footExtras,
  onSend,
}: {
  placeholder: string;
  disabled?: boolean;
  /** Page-specific foot controls — the transcript link and "New chat" on the start card. */
  footExtras?: ReactNode;
  /** Fired after the turn is handed off — the start card navigates to the session here. */
  onSend?: (prompt: string) => void;
}) {
  const { chat, pendingPrompt, isSending, sendError, isStopping, stopError, send, stop } = useChatSession();
  const [draft, setDraft] = useState("");

  const submit = (prompt: string) => {
    // Cleared here rather than on success: the prompt is already on screen as a turn.
    setDraft("");
    send(prompt);
    onSend?.(prompt);
  };

  return (
    <>
      {(chat || pendingPrompt) && (
        <div className="chat-log">
          {chat?.turns.map((turn, i) => (
            <div key={i} className={`chat-turn ${turn.role}`}>
              <span className="chat-role">{turn.role === "user" ? "You" : "Claude"}</span>
              {turn.role === "assistant" ? <Markdown source={turn.text} /> : <p>{turn.text}</p>}
            </div>
          ))}
          {pendingPrompt && (
            <>
              <div className="chat-turn user">
                <span className="chat-role">You</span>
                <p>{pendingPrompt}</p>
              </div>
              <div className="chat-turn assistant">
                <span className="chat-role">Claude</span>
                <p className="muted">Working…</p>
              </div>
            </>
          )}
        </div>
      )}

      {/* A cut-short turn's partial reply, labelled so it doesn't read as the answer. */}
      {chat?.interrupted && (
        <p className="muted chat-note">{INTERRUPTION_NOTE[chat.interrupted]} — this is what arrived before it ended.</p>
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
        onSubmit={submit}
        placeholder={placeholder}
        disabled={disabled}
        status={isSending ? "submitted" : sendError ? "error" : "ready"}
      />

      <div className="chat-foot">
        {sendError && <span className="error">{sendError.message}</span>}
        {stopError && <span className="error">{stopError.message}</span>}
        {/* An agent turn can run for minutes; this is the only way to take it back. */}
        {isSending && (
          <button type="button" className="chat-stop" onClick={stop} disabled={isStopping}>
            {isStopping ? "Stopping…" : "Stop"}
          </button>
        )}
        {chat && (
          <span className="muted">
            {fmtInt(chat.usage.input + chat.usage.cacheRead + chat.usage.cacheCreation)} in ·{" "}
            {fmtInt(chat.usage.output)} out
          </span>
        )}
        {footExtras}
      </div>
    </>
  );
}

/** One tool the turn ran; a failure carries the first line of its `tool_result` text. */
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
