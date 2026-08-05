/**
 * Unit tests for the message cache-breakpoint injector. Zero-dependency — Node's
 * built-in runner, which strips the types itself.
 *
 * Run:  node --test proxy/cache-breakpoint.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetWarmPrefixes, ensureMessageBreakpoint, hasWarmPrefix, noteCacheRead } from './cache-breakpoint.ts';
import type { ContentBlock, RequestBody, WireMessage } from './wire.ts';

const SESSION = 'session-under-test';

/** Enough transcript to clear the byte gate on its own. */
const FILLER = 'x'.repeat(120_000);

const EPHEMERAL_1H = { type: 'ephemeral', ttl: '1h' };

/** A system prompt shaped like a healthy turn's: two of its blocks keyed. */
const systemBlocks = (cacheControl: unknown = EPHEMERAL_1H): ContentBlock[] => [
  { type: 'text', text: 'preamble, unkeyed' },
  { type: 'text', text: 'the big static prefix', cache_control: cacheControl },
  { type: 'text', text: 'tools', cache_control: cacheControl },
];

/** A cold request: system breakpoints present, none on any message. */
function coldRequest(overrides: Partial<RequestBody> = {}): RequestBody {
  return {
    model: 'claude-opus-5',
    system: systemBlocks(),
    messages: [
      { role: 'user', content: [{ type: 'text', text: FILLER }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first block' },
          { type: 'text', text: 'the final block' },
        ],
      },
    ],
    ...overrides,
  };
}

/** Mark this session's prefix warm: a read well past the system prefix. */
function warmUp(sessionKey = SESSION): void {
  _resetWarmPrefixes();
  noteCacheRead(sessionKey, 180_000, 48_000);
}

const lastBlockOf = (req: RequestBody | null): ContentBlock => {
  const messages = req?.messages as WireMessage[];
  const content = messages[messages.length - 1]!.content as ContentBlock[];
  return content[content.length - 1]!;
};

test('injects on the last content block of the last message', () => {
  warmUp();
  const before = coldRequest();
  const snapshot = JSON.stringify(before);

  const { reqJson, injected } = ensureMessageBreakpoint(before, { sessionKey: SESSION });

  assert.equal(injected, true);
  assert.deepEqual(lastBlockOf(reqJson).cache_control, EPHEMERAL_1H);

  // Only the final block is keyed, and only the final message is rewritten.
  const messages = reqJson?.messages as WireMessage[];
  const lastContent = messages[1]!.content as ContentBlock[];
  assert.equal(lastContent[0]!.cache_control, undefined, 'the earlier block stays unkeyed');
  assert.equal(lastContent[0]!.text, 'first block', 'and keeps its text');
  assert.equal((messages[0]!.content as ContentBlock[])[0]!.text, FILLER, 'earlier messages ride through');
  assert.equal(JSON.stringify(before), snapshot, 'the caller’s object is never mutated');
});

test('copies the TTL off the system block instead of hardcoding 1h', () => {
  warmUp();
  const fiveMinutes = { type: 'ephemeral', ttl: '5m' };
  const { reqJson, injected } = ensureMessageBreakpoint(coldRequest({ system: systemBlocks(fiveMinutes) }), {
    sessionKey: SESSION,
  });

  assert.equal(injected, true);
  assert.deepEqual(lastBlockOf(reqJson).cache_control, fiveMinutes);
});

test('carries through a cache_control field the proxy has never seen', () => {
  warmUp();
  const exotic = { type: 'ephemeral', ttl: '1h', some_future_field: 7 };
  const { reqJson } = ensureMessageBreakpoint(coldRequest({ system: systemBlocks(exotic) }), { sessionKey: SESSION });

  assert.deepEqual(lastBlockOf(reqJson).cache_control, exotic);
});

test('no-op when a message already carries a breakpoint — the self-retirement gate', () => {
  warmUp();
  const healthy = coldRequest();
  const messages = healthy.messages as WireMessage[];
  (messages[1]!.content as ContentBlock[])[1]!.cache_control = EPHEMERAL_1H;

  const { reqJson, injected } = ensureMessageBreakpoint(healthy, { sessionKey: SESSION });

  assert.equal(injected, false);
  assert.equal(reqJson, healthy, 'same reference — the body is forwarded byte-for-byte');
});

test('no-op when a breakpoint sits on a nested tool_result block', () => {
  warmUp();
  const req = coldRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: FILLER }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: 'result', cache_control: EPHEMERAL_1H }],
          },
        ],
      },
    ],
  });

  const { injected } = ensureMessageBreakpoint(req, { sessionKey: SESSION });
  assert.equal(injected, false, 'an ambiguous body stays on the no-op side');
});

test('no-op when no system block carries a breakpoint', () => {
  warmUp();
  const unkeyed = coldRequest({ system: [{ type: 'text', text: 'no caching asked for' }] });

  const { reqJson, injected } = ensureMessageBreakpoint(unkeyed, { sessionKey: SESSION });

  assert.equal(injected, false, 'caching is never invented for a client not asking for it');
  assert.equal(reqJson, unkeyed);
});

test('no-op when system is a bare string, which carries no breakpoint', () => {
  warmUp();
  const { injected } = ensureMessageBreakpoint(coldRequest({ system: 'a plain string prompt' }), {
    sessionKey: SESSION,
  });
  assert.equal(injected, false);
});

test('no-op below the size gate — a write on a short prompt loses money', () => {
  warmUp();
  const shallow = coldRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });

  const { reqJson, injected } = ensureMessageBreakpoint(shallow, { sessionKey: SESSION });

  assert.equal(injected, false);
  assert.equal(reqJson, shallow);
});

test('a long turn count clears the depth gate on its own', () => {
  warmUp();
  const many: WireMessage[] = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `turn ${i}` }],
  }));

  const { injected } = ensureMessageBreakpoint(coldRequest({ messages: many }), { sessionKey: SESSION });
  assert.equal(injected, true, 'many small messages are a deep transcript too');
});

test('no-op when the session has no warm prefix', () => {
  _resetWarmPrefixes();
  const cold = coldRequest();

  const { reqJson, injected } = ensureMessageBreakpoint(cold, { sessionKey: SESSION });

  assert.equal(injected, false, 'without a read to recover it, a write is pure loss');
  assert.equal(reqJson, cold);
});

test('no-op when the request carries no session at all', () => {
  warmUp();
  const { injected } = ensureMessageBreakpoint(coldRequest(), { sessionKey: null });
  assert.equal(injected, false);
});

test('warm prefix needs a read past the system prefix, not merely any read', () => {
  _resetWarmPrefixes();
  noteCacheRead(SESSION, 48_000, 48_000);
  assert.equal(hasWarmPrefix(SESSION), false, 'reading only the system prefix proves nothing about messages');

  noteCacheRead(SESSION, 48_001, 48_000);
  assert.equal(hasWarmPrefix(SESSION), true);
});

test('noteCacheRead ignores a request whose prefix size is unknown', () => {
  _resetWarmPrefixes();
  noteCacheRead(SESSION, 200_000, 0);
  assert.equal(hasWarmPrefix(SESSION), false);
});

test('no-op when system already holds the four breakpoints the API allows', () => {
  warmUp();
  const capped = coldRequest({
    system: [
      { type: 'text', text: 'a', cache_control: EPHEMERAL_1H },
      { type: 'text', text: 'b', cache_control: EPHEMERAL_1H },
      { type: 'text', text: 'c', cache_control: EPHEMERAL_1H },
      { type: 'text', text: 'd', cache_control: EPHEMERAL_1H },
    ],
  });

  const { reqJson, injected } = ensureMessageBreakpoint(capped, { sessionKey: SESSION });

  assert.equal(injected, false, 'a fifth breakpoint is an API error, not a saving');
  assert.equal(reqJson, capped);
});

test('PROXY_CACHE_BREAKPOINT=off is honoured', () => {
  warmUp();
  const previous = process.env.PROXY_CACHE_BREAKPOINT;
  try {
    process.env.PROXY_CACHE_BREAKPOINT = 'off';
    const req = coldRequest();
    const { reqJson, injected } = ensureMessageBreakpoint(req, { sessionKey: SESSION });
    assert.equal(injected, false);
    assert.equal(reqJson, req);
  } finally {
    if (previous === undefined) delete process.env.PROXY_CACHE_BREAKPOINT;
    else process.env.PROXY_CACHE_BREAKPOINT = previous;
  }
});

test('injects by default — the kill switch is opt-out', () => {
  warmUp();
  const previous = process.env.PROXY_CACHE_BREAKPOINT;
  try {
    delete process.env.PROXY_CACHE_BREAKPOINT;
    assert.equal(ensureMessageBreakpoint(coldRequest(), { sessionKey: SESSION }).injected, true);
  } finally {
    if (previous !== undefined) process.env.PROXY_CACHE_BREAKPOINT = previous;
  }
});

test('a malformed body passes through untouched', () => {
  warmUp();
  for (const body of [null, {}, { messages: 'not an array' }, { messages: [] }] as Array<RequestBody | null>) {
    const { reqJson, injected } = ensureMessageBreakpoint(body, { sessionKey: SESSION });
    assert.equal(injected, false);
    assert.equal(reqJson, body, 'the same reference is handed back');
  }
});

test('a last message whose content is a bare string is left alone', () => {
  warmUp();
  const req = coldRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: FILLER }] },
      { role: 'assistant', content: 'a plain string turn' },
    ],
  });

  const { reqJson, injected } = ensureMessageBreakpoint(req, { sessionKey: SESSION });

  assert.equal(injected, false, 'there is no block to carry the hint');
  assert.equal(reqJson, req);
});
