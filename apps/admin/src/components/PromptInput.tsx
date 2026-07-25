import { useCallback, useEffect, useRef } from "react";

/** Where a submit stands, so the button can show it. */
export type PromptStatus = "ready" | "submitted" | "error";

const SUBMIT_TITLE: Record<PromptStatus, string> = {
  ready: "Send (Enter)",
  submitted: "Sending…",
  error: "Send again (Enter)",
};

export interface PromptInputProps {
  value: string;
  onValueChange: (next: string) => void;
  /** Called with the trimmed value; never fires empty or while submitted. */
  onSubmit: (prompt: string) => void;
  placeholder?: string;
  disabled?: boolean;
  status?: PromptStatus;
  /** Rows the textarea starts at; it grows with the content from there. */
  minRows?: number;
  /** Ceiling for the auto-grow, in rows. */
  maxRows?: number;
}

/** Line height used to translate rows into the auto-grow bounds (matches the CSS). */
const LINE_HEIGHT = 21;
const VERTICAL_PADDING = 20;

/**
 * A chat prompt input — one auto-growing textarea plus a send button, following the
 * shadcn AI prompt-input anatomy (Enter submits, Shift+Enter breaks the line, the
 * button disables while a submit is in flight).
 *
 * Hand-rolled rather than pulled from the shadcn registry: this app styles itself
 * with plain CSS tokens in `styles.css` and has no Tailwind or `components.json`, so
 * `shadcn add` has nothing to write into. The behavior and markup structure are the
 * registry component's; the styling is this dashboard's.
 */
export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  placeholder = "Send a message…",
  disabled = false,
  status = "ready",
  minRows = 2,
  maxRows = 10,
}: PromptInputProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const busy = status === "submitted";
  const blocked = disabled || busy;

  // Auto-grow: measure content, clamp between minRows and maxRows, scroll past that.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const min = minRows * LINE_HEIGHT + VERTICAL_PADDING;
    const max = maxRows * LINE_HEIGHT + VERTICAL_PADDING;
    el.style.height = "auto";
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value, minRows, maxRows]);

  const submit = useCallback(() => {
    const prompt = value.trim();
    if (!prompt || blocked) return;
    onSubmit(prompt);
  }, [value, blocked, onSubmit]);

  return (
    <form
      className="prompt-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textarea}
        className="prompt-input-textarea"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        rows={minRows}
        aria-label={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter (and IME composition) writes a newline.
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          submit();
        }}
      />
      <div className="prompt-input-toolbar">
        <span className="muted prompt-input-hint">
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        </span>
        <button
          type="submit"
          className="prompt-input-submit"
          disabled={blocked || !value.trim()}
          title={SUBMIT_TITLE[status]}
          aria-label={SUBMIT_TITLE[status]}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
