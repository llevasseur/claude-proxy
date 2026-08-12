import { describe, expect, it } from 'vitest';
import {
  aggregateContext,
  analyzeRequestBody,
  attachContextPrompts,
  type ContextEntry,
  extractRequestMessage,
  extractRequestTool,
  groupContextThreads,
  sessionContextPeak,
  summarizeContext,
  toContextEntry,
} from '../src/context.js';
import { makeSidecar } from './helpers.js';

function entry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    file: '2026-07-20T13-31-00-278_anthropic',
    timestamp: '2026-07-20T13:31:00.278Z',
    model: 'claude-opus-4-8',
    sessionId: null,
    threadId: null,
    prompt: null,
    realInput: 10_000,
    systemBytes: 8_000,
    toolsBytes: 24_000,
    totalBytes: 60_000,
    toolCount: 2,
    ...overrides,
  };
}

describe('summarizeContext', () => {
  it('returns a well-formed empty summary for no input', () => {
    const s = summarizeContext([]);
    expect(s.requestCount).toBe(0);
    expect(s.avgRealInput).toBe(0);
    expect(s.medianRealInput).toBe(0);
    expect(s.maxRealInput).toBe(0);
    expect(s.max).toBeNull();
    expect(s.top).toEqual([]);
    expect(s.entries).toEqual([]);
  });

  it('computes average, median, and max over several entries', () => {
    const s = summarizeContext([entry({ realInput: 10 }), entry({ realInput: 20 }), entry({ realInput: 60 })]);
    expect(s.requestCount).toBe(3);
    expect(s.avgRealInput).toBe(30); // (10+20+60)/3
    expect(s.medianRealInput).toBe(20);
    expect(s.maxRealInput).toBe(60);
    expect(s.max?.realInput).toBe(60);
  });

  it('averages the two middle values for an even count', () => {
    const s = summarizeContext([
      entry({ realInput: 10 }),
      entry({ realInput: 20 }),
      entry({ realInput: 30 }),
      entry({ realInput: 50 }),
    ]);
    expect(s.medianRealInput).toBe(25); // round((20+30)/2)
  });

  it('orders top by largest and caps at topN', () => {
    const entries = [100, 500, 300, 200, 400].map((n, i) => entry({ realInput: n, file: `f${i}` }));
    const s = summarizeContext(entries, { topN: 3 });
    expect(s.top.map((e) => e.realInput)).toEqual([500, 400, 300]);
    expect(s.max?.realInput).toBe(500);
  });

  it('returns every entry oldest-first, regardless of input order', () => {
    const s = summarizeContext([
      entry({ file: 'b', timestamp: '2026-07-20T13:31:02.000Z' }),
      entry({ file: 'a', timestamp: '2026-07-20T13:31:00.000Z' }),
      entry({ file: 'c', timestamp: '2026-07-20T13:31:01.000Z' }),
    ]);
    expect(s.entries.map((e) => e.file)).toEqual(['a', 'c', 'b']);
  });

  it('keeps the earlier entry ahead of a tie in top, and as max', () => {
    const entries = [
      entry({ file: 'first-500', realInput: 500 }),
      entry({ file: 'only-400', realInput: 400 }),
      entry({ file: 'second-500', realInput: 500 }),
    ];
    const s = summarizeContext(entries, { topN: 2 });
    expect(s.top.map((e) => e.file)).toEqual(['first-500', 'second-500']);
    expect(s.max?.file).toBe('first-500');
  });

  it('caps top at the number of entries when topN is larger', () => {
    const s = summarizeContext([entry({ realInput: 1 }), entry({ realInput: 2 })], { topN: 10 });
    expect(s.top).toHaveLength(2);
  });

  it('still reports max when topN asks for no top list', () => {
    const s = summarizeContext([entry({ realInput: 10 }), entry({ realInput: 90 })], { topN: 0 });
    expect(s.top).toEqual([]);
    expect(s.max?.realInput).toBe(90);
    expect(s.maxRealInput).toBe(90);
  });

  it('takes a precomputed aggregate half verbatim and still sorts entries', () => {
    const entries = [
      entry({ file: 'b', timestamp: '2026-07-20T13:31:02.000Z' }),
      entry({ file: 'a', timestamp: '2026-07-20T13:31:00.000Z' }),
    ];
    const supplied = aggregateContext(entries);
    const s = summarizeContext(entries, { aggregates: { ...supplied, requestCount: 99 } });
    expect(s.requestCount).toBe(99);
    expect(s.entries.map((e) => e.file)).toEqual(['a', 'b']);
  });
});

/**
 * The aggregate half used to come from sorting a copy of the whole entry array
 * descending by `realInput`. `/api/context` is compared byte-for-byte across both
 * read backings, so the one-pass version has to agree with that sort exactly —
 * including where it put ties, which is the only place the two could differ.
 */
describe('aggregateContext', () => {
  /** What the two whole-array sorts produced, kept as the reference to agree with. */
  function bySorting(entries: readonly ContextEntry[], topN = 10) {
    const tokens = entries.map((e) => e.realInput).sort((a, b) => a - b);
    const sum = tokens.reduce((n, v) => n + v, 0);
    const byLargest = [...entries].sort((a, b) => b.realInput - a.realInput);
    const n = tokens.length;
    const mid = Math.floor(n / 2);
    return {
      requestCount: n,
      avgRealInput: n === 0 ? 0 : Math.round(sum / n),
      medianRealInput: n === 0 ? 0 : n % 2 === 0 ? Math.round((tokens[mid - 1]! + tokens[mid]!) / 2) : tokens[mid]!,
      maxRealInput: n === 0 ? 0 : tokens[n - 1]!,
      max: byLargest[0] ?? null,
      top: byLargest.slice(0, topN),
    };
  }

  it('agrees with the sorts it replaced over a corpus dense in ties', () => {
    // A deterministic pseudo-random spread with a small value range, so ties are
    // frequent rather than incidental — ties are the whole risk.
    let seed = 1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const entries = Array.from({ length: 500 }, (_, i) =>
      entry({ file: `f${i}`, realInput: next() % 25, timestamp: `2026-07-20T13:31:00.${String(i).padStart(3, '0')}Z` }),
    );

    for (const topN of [0, 1, 10, 499, 500, 501]) {
      expect(aggregateContext(entries, { topN })).toEqual(bySorting(entries, topN));
    }
  });

  it('agrees with the sorts it replaced on an even count and on none at all', () => {
    const even = [40, 10, 30, 20].map((n, i) => entry({ file: `f${i}`, realInput: n }));
    expect(aggregateContext(even)).toEqual(bySorting(even));
    expect(aggregateContext([])).toEqual(bySorting([]));
  });
});

describe('toContextEntry', () => {
  it('maps a valid sidecar and keeps the file handle', () => {
    const e = toContextEntry(makeSidecar(), 'myfile_anthropic');
    expect(e).not.toBeNull();
    expect(e!.file).toBe('myfile_anthropic');
    expect(e!.realInput).toBe(9_100);
    expect(e!.systemBytes).toBe(8_000);
    expect(e!.toolCount).toBe(2);
  });

  it('returns null for a malformed sidecar', () => {
    expect(toContextEntry({ nope: true }, 'x')).toBeNull();
  });

  it('carries the session id through, and null when the sidecar predates it', () => {
    const withSession = makeSidecar({
      session: {
        sessionId: 'abc-123',
        app: 'cli',
        userAgent: null,
        account: null,
        metadataSessionId: 'abc-123',
        deviceId: null,
      },
    });
    expect(toContextEntry(withSession, 'f')!.sessionId).toBe('abc-123');
    expect(toContextEntry(makeSidecar(), 'f')!.sessionId).toBeNull();
  });
});

describe('sessionContextPeak', () => {
  const entries = [
    entry({ file: 'a', sessionId: 's1', realInput: 10_000 }),
    entry({ file: 'b', sessionId: 's2', realInput: 90_000 }),
    entry({ file: 'c', sessionId: 's1', realInput: 42_000 }),
    entry({ file: 'd', sessionId: null, realInput: 99_000 }),
  ];

  it('picks the largest request carrying the session id', () => {
    const { peak, requestCount } = sessionContextPeak(entries, 's1');
    expect(peak!.file).toBe('c');
    expect(requestCount).toBe(2);
  });

  it('is empty for a null id, so legacy sidecars never match each other', () => {
    expect(sessionContextPeak(entries, null)).toEqual({ requestCount: 0, peak: null });
  });

  it('is empty for a session with no captured requests', () => {
    expect(sessionContextPeak(entries, 's3')).toEqual({ requestCount: 0, peak: null });
  });
});

describe('analyzeRequestBody', () => {
  it('measures system, tools, and messages of a normal body', () => {
    const body = {
      system: [{ type: 'text', text: 'you are helpful' }],
      tools: [
        { name: 'Bash', description: 'run shell' },
        { name: 'Read', description: 'read files' },
      ],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      ],
    };
    const b = analyzeRequestBody(body);
    expect(b.toolCount).toBe(2);
    expect(b.messageCount).toBe(2);
    expect(b.systemBytes).toBeGreaterThan(0);
    expect(b.toolsBytes).toBeGreaterThan(0);
    // Tools are ranked largest-first.
    expect(b.tools[0]!.bytes).toBeGreaterThanOrEqual(b.tools[1]!.bytes);
    expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(b.messages[0]!.index).toBe(0);
    expect(b.tools.every((t) => t.estTokens === Math.round(t.bytes / 4))).toBe(true);
  });

  it('handles string content and missing names', () => {
    const b = analyzeRequestBody({ tools: [{ description: 'x' }], messages: [{ content: 'no role' }] });
    expect(b.tools[0]!.name).toBe('(unnamed)');
    expect(b.messages[0]!.role).toBe('unknown');
  });

  it('is tolerant of an empty or malformed body', () => {
    const empty = analyzeRequestBody({});
    expect(empty.toolCount).toBe(0);
    expect(empty.messageCount).toBe(0);
    expect(empty.systemBytes).toBe(0);

    const junk = analyzeRequestBody(null);
    expect(junk.messageCount).toBe(0);
    expect(junk.tools).toEqual([]);
  });
});

describe('extractRequestMessage', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ],
  };

  it('returns the full message content and size facts by index', () => {
    const m = extractRequestMessage(body, 1);
    expect(m).not.toBeNull();
    expect(m!.index).toBe(1);
    expect(m!.role).toBe('assistant');
    expect(m!.messageCount).toBe(2);
    expect(m!.bytes).toBeGreaterThan(0);
    expect(m!.estTokens).toBe(Math.round(m!.bytes / 4));
    expect(JSON.parse(m!.content)).toEqual(body.messages[1]);
  });

  it('returns null for an out-of-range or non-integer index', () => {
    expect(extractRequestMessage(body, 2)).toBeNull();
    expect(extractRequestMessage(body, -1)).toBeNull();
    expect(extractRequestMessage(body, 0.5)).toBeNull();
  });

  it('defaults role to unknown and tolerates a malformed body', () => {
    expect(extractRequestMessage({ messages: [{ content: 'no role' }] }, 0)!.role).toBe('unknown');
    expect(extractRequestMessage({}, 0)).toBeNull();
    expect(extractRequestMessage(null, 0)).toBeNull();
  });
});

describe('extractRequestTool', () => {
  const body = {
    tools: [
      { name: 'Bash', description: 'run shell' },
      { name: 'Read', description: 'read files', input_schema: { type: 'object' } },
    ],
  };

  it('returns the full tool schema and size facts by index', () => {
    const t = extractRequestTool(body, 1);
    expect(t).not.toBeNull();
    expect(t!.index).toBe(1);
    expect(t!.name).toBe('Read');
    expect(t!.toolCount).toBe(2);
    expect(t!.bytes).toBeGreaterThan(0);
    expect(t!.estTokens).toBe(Math.round(t!.bytes / 4));
    expect(JSON.parse(t!.content)).toEqual(body.tools[1]);
  });

  it("index matches the tool's original array position, not its size rank", () => {
    // analyzeRequestBody sorts largest-first; the `index` handle must still
    // resolve the same tool through extractRequestTool.
    const b = analyzeRequestBody(body);
    for (const bt of b.tools) {
      expect(extractRequestTool(body, bt.index)!.name).toBe(bt.name);
    }
  });

  it('returns null for an out-of-range or non-integer index', () => {
    expect(extractRequestTool(body, 2)).toBeNull();
    expect(extractRequestTool(body, -1)).toBeNull();
    expect(extractRequestTool(body, 0.5)).toBeNull();
  });

  it('defaults name to (unnamed) and tolerates a malformed body', () => {
    expect(extractRequestTool({ tools: [{ description: 'no name' }] }, 0)!.name).toBe('(unnamed)');
    expect(extractRequestTool({}, 0)).toBeNull();
    expect(extractRequestTool(null, 0)).toBeNull();
  });
});

describe('groupContextThreads', () => {
  it('gathers a thread’s requests into one group, with its span and peak', () => {
    const groups = groupContextThreads([
      entry({ file: 'a', threadId: 't1', timestamp: '2026-07-20T13:31:00.000Z', realInput: 10, prompt: null }),
      entry({ file: 'b', threadId: 't1', timestamp: '2026-07-20T13:31:08.000Z', realInput: 90, prompt: 'go on' }),
      entry({ file: 'c', threadId: 't1', timestamp: '2026-07-20T13:31:04.000Z', realInput: 40 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.file)).toEqual(['a', 'b', 'c']);
    expect(groups[0]!.threadId).toBe('t1');
    expect(groups[0]!.prompt).toBe('go on');
    // The whole entry, so the one row can draw its cells from the largest request.
    expect(groups[0]!.peak.file).toBe('b');
    expect(groups[0]!.peak.realInput).toBe(90);
    // Oldest and newest, not first and last.
    expect(groups[0]!.firstTimestamp).toBe('2026-07-20T13:31:00.000Z');
    expect(groups[0]!.lastTimestamp).toBe('2026-07-20T13:31:08.000Z');
  });

  it('keeps the earlier request when two tie for the peak', () => {
    const groups = groupContextThreads([
      entry({ file: 'a', threadId: 't1', realInput: 50 }),
      entry({ file: 'b', threadId: 't1', realInput: 50 }),
    ]);
    expect(groups[0]!.peak.file).toBe('a');
  });

  it('lists the distinct models a thread used, first seen first', () => {
    const groups = groupContextThreads([
      entry({ file: 'a', threadId: 't1', model: 'claude-opus-4-8' }),
      entry({ file: 'b', threadId: 't1', model: 'claude-haiku-4-5' }),
      entry({ file: 'c', threadId: 't1', model: 'claude-opus-4-8' }),
    ]);
    expect(groups[0]!.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
  });

  it('gathers a thread whose requests are interleaved with another’s', () => {
    const groups = groupContextThreads([
      entry({ file: 'a', threadId: 't1' }),
      entry({ file: 'b', threadId: 't2' }),
      entry({ file: 'c', threadId: 't1' }),
      entry({ file: 'd', threadId: 't2' }),
    ]);
    expect(groups.map((g) => [g.threadId, g.entries.map((e) => e.file)])).toEqual([
      ['t1', ['a', 'c']],
      ['t2', ['b', 'd']],
    ]);
  });

  it('never gathers thread-less requests with each other', () => {
    const groups = groupContextThreads([
      entry({ file: 'a', threadId: null }),
      entry({ file: 'b', threadId: null }),
      entry({ file: 'c', threadId: 't1' }),
      entry({ file: 'd', threadId: 't1' }),
    ]);
    expect(groups.map((g) => g.entries.map((e) => e.file))).toEqual([['a'], ['b'], ['c', 'd']]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });

  it('returns no groups for no entries', () => {
    expect(groupContextThreads([])).toEqual([]);
  });
});

describe('attachContextPrompts', () => {
  const root =
    '<command-message>task</command-message> <command-name>/task</command-name>' +
    '<command-args>Make the breakdown searchable</command-args> the whole definition follows';

  it('gives every request of a thread the text its opening prompt was typed as', () => {
    const attached = attachContextPrompts(
      [entry({ threadId: 'aaaa000000000001' }), entry({ file: 'other', threadId: 'aaaa000000000001' })],
      new Map([['aaaa000000000001', root]]),
    );
    expect(attached.map((e) => e.prompt)).toEqual([
      '/task Make the breakdown searchable',
      '/task Make the breakdown searchable',
    ]);
  });

  it('leaves a request with no thread, or a thread with no prompt, unsearchable', () => {
    const attached = attachContextPrompts(
      [entry({ threadId: null }), entry({ file: 'b', threadId: 'aaaa000000000002' })],
      new Map([['aaaa000000000001', root]]),
    );
    expect(attached.map((e) => e.prompt)).toEqual([null, null]);
  });

  it('never matches a request to a prompt by session id', () => {
    const attached = attachContextPrompts(
      [entry({ sessionId: 's-1', threadId: null })],
      new Map([['aaaa000000000001', root]]),
    );
    expect(attached[0]!.prompt).toBeNull();
  });
});
