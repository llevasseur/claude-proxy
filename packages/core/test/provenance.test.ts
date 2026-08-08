import { describe, expect, it } from 'vitest';
import {
  applyIdeaMarks,
  applySuggestionJudgements,
  bucketJudgements,
  emptySuggestionStatusStore,
  isThinPass,
  isThreadId,
  parseIdeaMarks,
  parseIdeasStore,
  parseSuggestionJudgements,
  parseSuggestionStatusStore,
  parseWriteProvenance,
  provenanceCoverage,
  type SessionBucket,
  type SessionNode,
  transcriptsOpened,
} from '../src/index.js';

const JUDGE = '0123456789abcdef';
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';

const node = (index: number, type: SessionNode['type'], text: string): SessionNode => ({
  index,
  type,
  text,
  tool: type === 'tool' ? text : null,
  task: null,
  interruption: null,
  interrupted: false,
  message: null,
  turn: null,
});
const toolNode = (index: number, text: string): SessionNode => node(index, 'tool', text);

describe('the envelope', () => {
  it('accepts a 16-hex thread id and nothing else', () => {
    expect(isThreadId(JUDGE)).toBe(true);
    expect(isThreadId('abc')).toBe(false);
    expect(isThreadId(`${JUDGE}0`)).toBe(false);
    expect(isThreadId(JUDGE.toUpperCase())).toBe(false);
    expect(isThreadId(42)).toBe(false);
  });

  it('reads an absent or unusable envelope as null rather than throwing', () => {
    expect(parseWriteProvenance(undefined)).toBeNull();
    expect(parseWriteProvenance(null)).toBeNull();
    expect(parseWriteProvenance('x')).toBeNull();
    expect(parseWriteProvenance([])).toBeNull();
    expect(parseWriteProvenance({ window: 10, opened: 1 })).toBeNull();
    expect(parseWriteProvenance({ thread: 'nope' })).toBeNull();
  });

  it('keeps the counted pair or neither half of it', () => {
    expect(parseWriteProvenance({ thread: JUDGE, window: 10, opened: 3 })).toEqual({
      thread: JUDGE,
      window: 10,
      opened: 3,
    });
    // A count with no denominator measures nothing.
    expect(parseWriteProvenance({ thread: JUDGE, opened: 3 })).toEqual({ thread: JUDGE });
    expect(parseWriteProvenance({ thread: JUDGE, window: 10 })).toEqual({ thread: JUDGE });
    expect(parseWriteProvenance({ thread: JUDGE, window: 10, opened: -1 })).toEqual({ thread: JUDGE });
    expect(parseWriteProvenance({ thread: JUDGE, window: 10, opened: 1.5 })).toEqual({ thread: JUDGE });
  });
});

describe('the thin-pass marker', () => {
  it('measures coverage only when both halves are on record', () => {
    expect(provenanceCoverage({ thread: JUDGE, window: 10, opened: 2 })).toBe(0.2);
    expect(provenanceCoverage({ thread: JUDGE })).toBeNull();
    expect(provenanceCoverage(undefined)).toBeNull();
    // An empty window is not a thin pass, it is an unmeasurable one.
    expect(provenanceCoverage({ thread: JUDGE, window: 0, opened: 0 })).toBeNull();
  });

  it('fires under 30% and clears at or above it', () => {
    expect(isThinPass({ thread: JUDGE, window: 10, opened: 2 })).toBe(true);
    expect(isThinPass({ thread: JUDGE, window: 10, opened: 3 })).toBe(false);
    expect(isThinPass({ thread: JUDGE, window: 10, opened: 10 })).toBe(false);
  });

  it('never indicts a verdict that recorded nothing', () => {
    expect(isThinPass(undefined)).toBe(false);
    expect(isThinPass(null)).toBe(false);
    expect(isThinPass({ thread: JUDGE })).toBe(false);
  });
});

describe('counting what the judge opened', () => {
  it('counts a window transcript named by any tool call, not only Read', () => {
    const nodes = [
      toolNode(0, `Read(logs/sessions/${A}.md)`),
      toolNode(1, `Bash(rg -n foo logs/sessions/${B}.md)`),
      toolNode(2, 'Read(README.md)'),
    ];
    expect(transcriptsOpened(nodes, [A, B, C])).toEqual([A, B]);
  });

  it('prefers the sidecar text, so a truncated tool line still counts', () => {
    const nodes = [toolNode(0, 'Read(logs/sessions/aaaaaaaa…')];
    expect(transcriptsOpened(nodes, [A])).toEqual([]);
    expect(transcriptsOpened(nodes, [A], { 0: `Read(logs/sessions/${A}.md)` })).toEqual([A]);
  });

  it('ignores non-tool nodes and never credits the judge for its own transcript', () => {
    const nodes: SessionNode[] = [
      node(0, 'decision', `looked at ${A}`),
      toolNode(1, `Read(logs/sessions/${JUDGE}.md)`),
    ];
    expect(transcriptsOpened(nodes, [A, JUDGE], {}, JUDGE)).toEqual([]);
  });
});

describe('the suggestion store keeps legacy verdicts loading', () => {
  const legacy = { version: 2, buckets: {}, judged: { 4: { at: '2026-08-01T00:00:00.000Z', notes: {} } } };

  it('reads a verdict with no envelope, and one with a broken envelope, unchanged', () => {
    expect(parseSuggestionStatusStore(legacy).judged['4']).toEqual({ at: '2026-08-01T00:00:00.000Z', notes: {} });
    const broken = { ...legacy, judged: { 4: { ...legacy.judged[4], by: { thread: 'nope' } } } };
    // The envelope is dropped; the verdict underneath survives it.
    expect(parseSuggestionStatusStore(broken).judged['4']).toEqual({ at: '2026-08-01T00:00:00.000Z', notes: {} });
  });

  it('round-trips an envelope through a judgement write', () => {
    const by = { thread: JUDGE, window: 10, opened: 1 };
    const store = applySuggestionJudgements(emptySuggestionStatusStore(), [{ bucket: 4, by }], new Date());
    expect(store.judged['4']?.by).toEqual(by);
    expect(parseSuggestionStatusStore(JSON.parse(JSON.stringify(store))).judged['4']?.by).toEqual(by);
  });

  it('marks the bucket row thin, and leaves an unattributed one unmarked', () => {
    const bucket: SessionBucket = {
      index: 4,
      from: 31,
      to: 40,
      label: '31–40',
      complete: true,
      startedFirst: null,
      startedLast: null,
      threadIds: [A, B, C],
      stats: {
        sessions: 3,
        tasks: 0,
        decisions: 0,
        tools: 0,
        errors: 0,
        toolsPerTask: 0,
        unfinishedTasks: 0,
        topLevelTasks: 0,
        unfinishedSubagents: 0,
        subagentThreads: 0,
        discoveryRatio: 0,
        topTools: [],
      },
      suggestions: [],
    };
    const thin = applySuggestionJudgements(
      emptySuggestionStatusStore(),
      [{ bucket: 4, by: { thread: JUDGE, window: 10, opened: 1 } }],
      new Date(),
    );
    expect(bucketJudgements([bucket], thin)[0]?.thin).toBe(true);
    const plain = applySuggestionJudgements(emptySuggestionStatusStore(), [{ bucket: 4 }], new Date());
    expect(bucketJudgements([bucket], plain)[0]?.thin).toBeUndefined();
    expect(bucketJudgements([bucket], plain)[0]?.state).toBe('clean');
  });

  it('parses an envelope off untrusted judge input, and drops an unusable one', () => {
    const [ok] = parseSuggestionJudgements([{ bucket: 4, by: { thread: JUDGE, window: 10, opened: 1 } }]);
    expect(ok?.by).toEqual({ thread: JUDGE, window: 10, opened: 1 });
    const [dropped] = parseSuggestionJudgements([{ bucket: 4, by: { thread: 'nope' } }]);
    expect(dropped?.by).toBeUndefined();
  });
});

describe('the ideas ledger carries the same envelope', () => {
  const entry = {
    title: 'Something',
    rationale: 'because',
    evidence: [{ source: 'open-question', path: 'docs/x.md' }],
    repo: 'llevasseur/claude-proxy',
    status: 'proposed',
    created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-01T00:00:00.000Z',
  };

  it('reads an entry with no envelope, exactly as before', () => {
    const store = parseIdeasStore({ version: 1, ideas: { 'an-idea': entry } });
    expect(store.ideas['an-idea']?.status).toBe('proposed');
    expect(store.ideas['an-idea']?.by).toBeUndefined();
  });

  it('records who accepted an idea, and keeps it across a later note-only mark', () => {
    const store = parseIdeasStore({ version: 1, ideas: { 'an-idea': entry } });
    const accepted = applyIdeaMarks(store, [{ slug: 'an-idea', status: 'accepted', by: { thread: JUDGE } }]);
    expect(accepted.store.ideas['an-idea']?.by).toEqual({ thread: JUDGE });
    const shipped = applyIdeaMarks(accepted.store, [{ slug: 'an-idea', status: 'shipped', note: 'url' }]);
    expect(shipped.store.ideas['an-idea']?.by).toEqual({ thread: JUDGE });
  });

  it('refuses a malformed attribution on untrusted mark input', () => {
    expect(parseIdeaMarks([{ slug: 'an-idea', status: 'accepted', by: { thread: JUDGE } }])[0]?.by).toEqual({
      thread: JUDGE,
    });
    expect(() => parseIdeaMarks([{ slug: 'an-idea', status: 'accepted', by: { thread: 'nope' } }])).toThrow(
      /16-hex-character thread id/,
    );
  });
});
