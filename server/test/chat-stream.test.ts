import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetChatStreams,
  type ChatStreamFrame,
  closeChatTurn,
  dropChatStream,
  emitChatEvent,
  openChatTurn,
  snapshotChatStream,
  subscribeChatStream,
} from '../src/chat-stream.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

/** Subscribe and collect the frames pushed from here on. */
function watch(sessionId = SESSION) {
  const frames: ChatStreamFrame[] = [];
  const stop = subscribeChatStream(sessionId, (f) => frames.push(f));
  return { frames, stop };
}

describe('chat-stream', () => {
  beforeEach(() => _resetChatStreams());

  it('answers a session it has never heard of with an empty, inactive turn', () => {
    // The dashboard names the session id before its first turn and opens the stream in
    // the same tick as the POST, so this is the ordinary case rather than an error one.
    expect(snapshotChatStream(SESSION)).toEqual({
      sessionId: SESSION,
      turn: 0,
      active: false,
      interrupted: null,
      events: [],
      seq: 0,
      truncated: false,
    });
  });

  it('pushes each event once, in order, with its own sequence number', () => {
    const { frames } = watch();
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'one ' });
    emitChatEvent(SESSION, { type: 'tool', index: 0, name: 'Read' });
    emitChatEvent(SESSION, { type: 'tool-result', index: 0, failed: false });
    emitChatEvent(SESSION, { type: 'text', text: 'two' });

    expect(frames.map((f) => f.events)).toEqual([
      [],
      [{ type: 'text', text: 'one ' }],
      [{ type: 'tool', index: 0, name: 'Read' }],
      [{ type: 'tool-result', index: 0, failed: false }],
      [{ type: 'text', text: 'two' }],
    ]);
    expect(frames.map((f) => f.seq)).toEqual([0, 0, 1, 2, 3]);
    expect(frames.every((f) => f.turn === 1 && f.active)).toBe(true);
  });

  it('replays the live turn to a reader that connects mid-turn', () => {
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'already said' });
    emitChatEvent(SESSION, { type: 'tool', index: 0, name: 'Bash' });

    const snap = snapshotChatStream(SESSION);
    expect(snap.events).toEqual([
      { type: 'text', text: 'already said' },
      { type: 'tool', index: 0, name: 'Bash' },
    ]);
    expect(snap.active).toBe(true);
    expect(snap.turn).toBe(1);
  });

  it('starts a new turn rather than appending to the last one', () => {
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'first turn' });
    closeChatTurn(SESSION, null);
    openChatTurn(SESSION);

    const snap = snapshotChatStream(SESSION);
    expect(snap.turn).toBe(2);
    expect(snap.events).toEqual([]);
    expect(snap.active).toBe(true);
  });

  it('reports the turn ending, and how it ended', () => {
    const { frames } = watch();
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'partial' });
    closeChatTurn(SESSION, 'stopped');

    const last = frames.at(-1);
    expect(last?.active).toBe(false);
    expect(last?.interrupted).toBe('stopped');
    expect(last?.events).toEqual([]); // the finished text is the POST's answer, not this
    expect(snapshotChatStream(SESSION).events).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('trims the replay of a turn that outruns the buffer, and says it did', () => {
    openChatTurn(SESSION);
    for (let i = 0; i < 4_100; i++) emitChatEvent(SESSION, { type: 'text', text: `${i} ` });

    const snap = snapshotChatStream(SESSION);
    expect(snap.truncated).toBe(true);
    expect(snap.events.length).toBe(4_000);
    expect(snap.seq).toBe(100);
    expect(snap.events[0]).toEqual({ type: 'text', text: '100 ' });
    expect(snap.events.at(-1)).toEqual({ type: 'text', text: '4099 ' });
  });

  it('keeps streaming to every listener when one of them throws', () => {
    subscribeChatStream(SESSION, () => {
      throw new Error('dead writer');
    });
    const { frames } = watch();
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'still arrives' });
    expect(frames.at(-1)?.events).toEqual([{ type: 'text', text: 'still arrives' }]);
  });

  it('stops pushing to a listener that unsubscribed', () => {
    const { frames, stop } = watch();
    openChatTurn(SESSION);
    stop();
    emitChatEvent(SESSION, { type: 'text', text: 'unheard' });
    expect(frames.flatMap((f) => f.events)).toEqual([]);
  });

  it('keeps a running turn buffered when its last reader leaves, and forgets an idle one', () => {
    const running = watch();
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'mid-turn' });
    running.stop();
    // The turn is still running, so a reconnect must still find what it missed.
    expect(snapshotChatStream(SESSION).events).toEqual([{ type: 'text', text: 'mid-turn' }]);

    const idle = watch();
    closeChatTurn(SESSION, null);
    idle.stop();
    expect(snapshotChatStream(SESSION).turn).toBe(0); // dropped, so this is a fresh buffer
  });

  it('drops a session outright — what "New chat" does alongside evicting the session', () => {
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'old chat' });
    dropChatStream(SESSION);
    expect(snapshotChatStream(SESSION)).toMatchObject({ turn: 0, active: false, events: [] });
  });

  it('ignores an event for a session with no buffer, rather than opening one', () => {
    emitChatEvent(SESSION, { type: 'text', text: 'nobody asked' });
    closeChatTurn(SESSION, null);
    // `snapshotChatStream` is what creates a buffer on demand; emitting must not.
    expect(snapshotChatStream(SESSION).events).toEqual([]);
  });

  it('keeps sessions apart', () => {
    const other = '99999999-8888-7777-6666-555555555555';
    openChatTurn(SESSION);
    emitChatEvent(SESSION, { type: 'text', text: 'mine' });
    openChatTurn(other);
    emitChatEvent(other, { type: 'text', text: 'theirs' });

    expect(snapshotChatStream(SESSION).events).toEqual([{ type: 'text', text: 'mine' }]);
    expect(snapshotChatStream(other).events).toEqual([{ type: 'text', text: 'theirs' }]);
  });
});
