/**
 * chat-stream — what a chat turn is doing, while it is still doing it.
 *
 * A turn's POST does not answer until the turn is over, and an agent turn runs for
 * minutes or hours. This is the second channel: the server is already decoding a stream
 * that interleaves the reply's text with the tools the turn runs, so it re-emits that
 * same interleaving over the dashboard's ordinary SSE plumbing.
 *
 * **This channel is an accessory, never the record.** The POST's finished
 * `ChatSendResult` remains the truth about a turn — decoded from the whole stream
 * whether or not anyone watched. A watcher that connects late, drops mid-turn, or never
 * connects at all changes nothing about the turn.
 *
 * Buffers are per session id and hold the live turn only, so a reader that connects
 * mid-turn or reconnects after a drop is given what it missed.
 */

import type { CliInterruption } from './chat-cli.js';

/** One thing a turn did, in the order it did it. */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  /** A tool was called. `index` is its position in the turn's finished `tools` list. */
  | { type: 'tool'; index: number; name: string }
  /** That tool answered. A failure carries its `tool_result` text, as the chip does. */
  | { type: 'tool-result'; index: number; failed: boolean; error?: string };

/** One SSE frame: the turn it belongs to, and the events it carries. */
export interface ChatStreamFrame {
  sessionId: string;
  /**
   * Which turn of this session the events belong to. A reader that sees it change is
   * looking at a different turn and starts over rather than appending.
   */
  turn: number;
  /** True while the turn is still running. */
  active: boolean;
  /** Set once the turn ended early; null while it runs and on a turn that finished. */
  interrupted: CliInterruption | null;
  /** The events this frame carries, oldest first. Empty on a frame that only reports state. */
  events: ChatStreamEvent[];
  /** The sequence number of `events[0]`, counted from the turn's first event. */
  seq: number;
  /**
   * True when the turn outran the buffer and its oldest events were dropped, so a
   * reader's text begins mid-reply. The POST's reply is still whole.
   */
  truncated: boolean;
}

/**
 * How much of a turn is replayable to a reader that arrives late. A turn that outruns
 * this keeps streaming — only the replay is trimmed, and `truncated` says so.
 */
const MAX_BUFFERED_EVENTS = 4_000;

interface TurnStream {
  turn: number;
  active: boolean;
  interrupted: CliInterruption | null;
  /** The live turn's events, oldest first, trimmed to {@link MAX_BUFFERED_EVENTS}. */
  events: ChatStreamEvent[];
  /** The sequence number of `events[0]`; above zero once the head was trimmed. */
  seq: number;
  truncated: boolean;
  listeners: Set<(frame: ChatStreamFrame) => void>;
}

/** Live turn buffers, keyed by chat session id. */
const streams = new Map<string, TurnStream>();

/**
 * The buffer for a session, created on demand. Either side may arrive first: the
 * dashboard opens the stream in the same tick as the POST, so a reader routinely asks
 * for a session the server has yet to hear of.
 */
function streamFor(sessionId: string): TurnStream {
  const existing = streams.get(sessionId);
  if (existing) return existing;
  const fresh: TurnStream = {
    turn: 0,
    active: false,
    interrupted: null,
    events: [],
    seq: 0,
    truncated: false,
    listeners: new Set(),
  };
  streams.set(sessionId, fresh);
  return fresh;
}

const frameOf = (sessionId: string, s: TurnStream, events: ChatStreamEvent[], seq: number): ChatStreamFrame => ({
  sessionId,
  turn: s.turn,
  active: s.active,
  interrupted: s.interrupted,
  events,
  seq,
  truncated: s.truncated,
});

function broadcast(sessionId: string, s: TurnStream, events: ChatStreamEvent[], seq: number): void {
  if (!s.listeners.size) return;
  const frame = frameOf(sessionId, s, events, seq);
  for (const listener of s.listeners) {
    try {
      listener(frame);
    } catch {
      /* one dead writer must not stop the turn or the readers beside it */
    }
  }
}

/** Everything known about the live turn — the opening frame a new reader is sent. */
export function snapshotChatStream(sessionId: string): ChatStreamFrame {
  const s = streamFor(sessionId);
  return frameOf(sessionId, s, [...s.events], s.seq);
}

/** A turn is starting: the previous turn's events are done being replayed. */
export function openChatTurn(sessionId: string): void {
  const s = streamFor(sessionId);
  s.turn += 1;
  s.active = true;
  s.interrupted = null;
  s.events = [];
  s.seq = 0;
  s.truncated = false;
  broadcast(sessionId, s, [], 0);
}

/** Report one thing the turn did. A no-op for a session with no buffer yet. */
export function emitChatEvent(sessionId: string, event: ChatStreamEvent): void {
  const s = streams.get(sessionId);
  if (!s) return;
  const seq = s.seq + s.events.length;
  s.events.push(event);
  if (s.events.length > MAX_BUFFERED_EVENTS) {
    s.events.shift();
    s.seq += 1;
    s.truncated = true;
  }
  broadcast(sessionId, s, [event], seq);
}

/**
 * The turn is over. Readers are told so they can stop showing a live reply; the finished
 * text reaches them as the POST's own response, not through here.
 */
export function closeChatTurn(sessionId: string, interrupted: CliInterruption | null): void {
  const s = streams.get(sessionId);
  if (!s) return;
  s.active = false;
  s.interrupted = interrupted;
  broadcast(sessionId, s, [], s.seq + s.events.length);
}

/**
 * Watch a session's turns. The caller is handed each frame as it is produced and gets
 * the unsubscribe back; it is responsible for sending the snapshot itself, so the
 * opening frame and the pushes cannot interleave.
 *
 * An idle buffer with nobody watching is dropped when its last reader leaves, so a tab
 * that opened a stream and navigated away leaves nothing resident.
 */
export function subscribeChatStream(sessionId: string, onFrame: (frame: ChatStreamFrame) => void): () => void {
  const s = streamFor(sessionId);
  s.listeners.add(onFrame);
  return () => {
    s.listeners.delete(onFrame);
    if (!s.listeners.size && !s.active) streams.delete(sessionId);
  };
}

/** Forget a session's buffer — what "New chat" does, alongside evicting the session. */
export function dropChatStream(sessionId: string): void {
  streams.delete(sessionId);
}

/** Test seam: forget every buffer. */
export function _resetChatStreams(): void {
  streams.clear();
}
