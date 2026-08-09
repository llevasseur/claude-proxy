import { useEffect, useState } from 'react';
import { API_BASE, type ChatStreamEvent, type ChatStreamFrame, type ChatToolUse, chatStreamPath } from './api';

/** A tool on the live account of a turn: a chip that exists before its result does. */
export interface LiveToolUse extends ChatToolUse {
  /** False while the tool is still running — its `tool_result` has yet to come back. */
  done: boolean;
}

/** A turn as it happens, assembled from the frames that have arrived so far. */
export interface LiveTurn {
  /** The reply so far. Provisional: the POST's finished text replaces it. */
  text: string;
  /** The tools the turn has run, in the order it ran them. */
  tools: LiveToolUse[];
  /** True when the turn outran the server's replay buffer, so `text` starts mid-reply. */
  truncated: boolean;
  /** True once a frame has actually arrived — the stream is connected and carrying. */
  streaming: boolean;
}

const EMPTY: LiveTurn = { text: '', tools: [], truncated: false, streaming: false };

/** Fold one event onto the turn so far. */
function apply(turn: LiveTurn, event: ChatStreamEvent): LiveTurn {
  if (event.type === 'text') return { ...turn, text: turn.text + event.text };

  if (event.type === 'tool') {
    // Indexed rather than appended: the server counts tools for the whole turn, so a
    // reader that joined mid-turn has a gap, filled here rather than left as a hole.
    const tools = turn.tools.slice();
    while (tools.length < event.index) tools.push({ name: '…', failed: false, done: true });
    tools[event.index] = { name: event.name, failed: false, done: false };
    return { ...turn, tools };
  }

  const existing = turn.tools[event.index];
  if (!existing) return turn; // a result for a call this reader never saw
  const tools = turn.tools.slice();
  tools[event.index] = {
    ...existing,
    failed: event.failed,
    done: true,
    ...(event.error ? { error: event.error } : {}),
  };
  return { ...turn, tools };
}

/**
 * The turn in flight, streamed into the page.
 *
 * The server re-emits the stream it is already decoding, so text and tool activity
 * arrive interleaved in the order the turn produced them.
 *
 * **This is never the record of a turn.** The POST that started it still answers with
 * the finished reply. So there is no retry policy here beyond `EventSource`'s own
 * reconnect: a reconnecting stream is sent a fresh snapshot of the live buffer, and one
 * that never recovers costs nothing, because the finished text lands when the POST
 * resolves.
 *
 * `enabled: false` closes the stream and clears the turn, so the caller enables it for
 * exactly as long as a prompt is in flight.
 */
export function useChatStream(sessionId: string, enabled: boolean): LiveTurn {
  const [turn, setTurn] = useState<LiveTurn>(EMPTY);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setTurn(EMPTY);
      return;
    }
    setTurn(EMPTY);

    const es = new EventSource(`${API_BASE}${chatStreamPath(sessionId)}`);
    // Which turn of the session is being assembled; a frame from another one starts over.
    let assembling: number | null = null;

    const read = (ev: MessageEvent, replace: boolean) => {
      let frame: ChatStreamFrame;
      try {
        frame = JSON.parse(ev.data) as ChatStreamFrame;
      } catch {
        return; // a malformed frame; the next one re-syncs
      }
      const restart = replace || assembling === null || frame.turn !== assembling;
      assembling = frame.turn;
      setTurn((prev) => {
        const base = restart ? EMPTY : prev;
        return {
          ...frame.events.reduce(apply, base),
          truncated: base.truncated || frame.truncated,
          streaming: true,
        };
      });
    };

    // A snapshot is the whole live turn, so it replaces; an update carries only what is new.
    const onSnapshot = (ev: Event) => read(ev as MessageEvent, true);
    const onUpdate = (ev: Event) => read(ev as MessageEvent, false);
    es.addEventListener('snapshot', onSnapshot);
    es.addEventListener('update', onUpdate);

    return () => es.close();
  }, [sessionId, enabled]);

  return turn;
}
