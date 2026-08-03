import { describe, expect, it } from 'vitest';
import { parseSessionNodes, parseSessionTranscript } from '../src/sessions.js';
import {
  bucketSessions,
  errorSignature,
  isDiscoveryCall,
  sessionSuggestionBuckets,
  suggestBucket,
  suggestFromBreakdown,
  summarizeBreakdownPatterns,
  toolName,
  type BucketBreakdownInput,
  type SuggestibleSession,
} from '../src/suggestions.js';

/** Build a session the rules can read, from real transcript text. */
function session(threadId: string, started: string | null, body: string[]): SuggestibleSession {
  const content = [
    '',
    `# Session ${threadId}`,
    '- model: claude-opus-5',
    `- session: sess-${threadId}`,
    ...(started ? [`- started: ${started}`] : []),
    '- title: A session',
    '',
    ...body,
  ].join('\n');
  return { ...parseSessionTranscript(threadId, content), nodes: parseSessionNodes(content) };
}

const day = (n: number) => `2026-07-${String(n).padStart(2, '0')}T10:00:00.000Z`;

describe('signature helpers', () => {
  it('pulls the tool name out of a truncated call signature', () => {
    expect(toolName('Read(file_path=/repo/src/a…')).toBe('Read');
    expect(toolName('Bash(command=npm test)')).toBe('Bash');
    expect(toolName(null)).toBeNull();
    expect(toolName('- not a call')).toBeNull();
  });

  it('counts reads, searches and inspecting shell commands as discovery', () => {
    expect(isDiscoveryCall('Read(file_path=/a.ts)')).toBe(true);
    expect(isDiscoveryCall('Grep(pattern=foo)')).toBe(true);
    expect(isDiscoveryCall('Bash(command=git status)')).toBe(true);
    expect(isDiscoveryCall('Bash(command=npm run build)')).toBe(false);
    expect(isDiscoveryCall('Edit(file_path=/a.ts)')).toBe(false);
  });

  it("collapses an error's wording to what recurs", () => {
    expect(errorSignature('File not found: /a/b.ts')).toBe(errorSignature('File not found: /c/d.ts'));
    expect(errorSignature('Exit code 1')).toBe(errorSignature('Exit code 2'));
    expect(errorSignature('Permission denied')).not.toBe(errorSignature('File not found'));
  });
});

describe('bucketSessions', () => {
  it('groups ten at a time, oldest first, with the remainder last', () => {
    const sessions = Array.from({ length: 23 }, (_, i) => ({
      threadId: `t${String(i).padStart(2, '0')}`,
      started: day(i + 1),
    }));
    const buckets = bucketSessions([...sessions].reverse());
    expect(buckets.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(buckets[0]![0]!.threadId).toBe('t00');
    expect(buckets[2]![2]!.threadId).toBe('t22');
  });

  it('orders sessions without a start time by thread id rather than dropping them', () => {
    const buckets = bucketSessions([
      { threadId: 'b', started: null },
      { threadId: 'a', started: null },
    ]);
    expect(buckets[0]!.map((s) => s.threadId)).toEqual(['a', 'b']);
  });
});

describe('suggestBucket', () => {
  it('flags guardrail refusals as high severity and names the sessions they hit', () => {
    const sessions = [
      session('a1', day(1), [
        '## Task: One',
        '- Bash(command=rm -rf /)',
        '- ✗ Permission denied by hook',
        '- done: ok',
      ]),
      session('a2', day(2), ['## Task: Two', '- Bash(command=curl x)', '- ✗ Blocked: tool not allowed', '- done: ok']),
    ];
    const blocked = suggestBucket(sessions).find((s) => s.id === 'blocked-guardrails');
    expect(blocked).toBeDefined();
    expect(blocked!.severity).toBe('high');
    expect(blocked!.sources.map((s) => s.threadId).sort()).toEqual(['a1', 'a2']);
  });

  it('reports an error that recurs across sessions once, with its occurrence count', () => {
    const sessions = [
      session('b1', day(1), [
        '## Task: One',
        '- Bash(command=pnpm test)',
        '- ✗ ENOENT: no such file /a.ts',
        '- done: ok',
      ]),
      session('b2', day(2), [
        '## Task: Two',
        '- Bash(command=pnpm test)',
        '- ✗ ENOENT: no such file /b.ts',
        '- done: ok',
      ]),
    ];
    const repeated = suggestBucket(sessions).find((s) => s.id === 'repeated-errors');
    expect(repeated).toBeDefined();
    expect(repeated!.evidence).toContain('2 occurrences');
  });

  it('flags an unbroken run of read-only calls but not one a decision interrupts', () => {
    const serial = session('c1', day(1), [
      '## Task: One',
      '- Read(file_path=/a.ts)',
      '- Read(file_path=/b.ts)',
      '- Grep(pattern=foo)',
      '- Read(file_path=/c.ts)',
      '- done: ok',
    ]);
    expect(suggestBucket([serial]).find((s) => s.id === 'serial-discovery')).toBeDefined();

    const interrupted = session('c2', day(1), [
      '## Task: One',
      '- Read(file_path=/a.ts)',
      '- Read(file_path=/b.ts)',
      '- decided: Now I know where to look.',
      '- Read(file_path=/c.ts)',
      '- Read(file_path=/d.ts)',
      '- done: ok',
    ]);
    expect(suggestBucket([interrupted]).find((s) => s.id === 'serial-discovery')).toBeUndefined();
  });

  it('flags a file read three times in one session', () => {
    const s = session('d1', day(1), [
      '## Task: One',
      '- Read(file_path=/a.ts)',
      '- Edit(file_path=/a.ts)',
      '- Read(file_path=/a.ts)',
      '- Edit(file_path=/a.ts)',
      '- Read(file_path=/a.ts)',
      '- done: ok',
    ]);
    const redundant = suggestBucket([s]).find((r) => r.id === 'redundant-reads');
    expect(redundant).toBeDefined();
    expect(redundant!.sources[0]!.threadId).toBe('d1');
  });

  it('counts a task with no outcome line as unfinished', () => {
    const sessions = [
      session('e1', day(1), ['## Task: One', '- Read(file_path=/a.ts)']),
      session('e2', day(2), ['## Task: Two', '- Read(file_path=/b.ts)']),
    ];
    const unfinished = suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks');
    expect(unfinished).toBeDefined();
    expect(unfinished!.evidence).toContain('2 of 2 tasks');
  });

  it("blames the tool that owns most of a bucket's failures", () => {
    const s = session('f1', day(1), [
      '## Task: One',
      '- Bash(command=pnpm test)',
      '- ✗ exit 1',
      '- Bash(command=pnpm build)',
      '- ✗ exit 2',
      '- Read(file_path=/a.ts)',
      '- ✗ file missing',
      '- done: ok',
    ]);
    const blamed = suggestBucket([s]).find((r) => r.id === 'error-prone-tool');
    expect(blamed).toBeDefined();
    expect(blamed!.title).toContain('Bash');
  });

  it('says so plainly when nothing trips a threshold', () => {
    const s = session('g1', day(1), ['## Task: One', '- Edit(file_path=/a.ts)', '- done: ok']);
    expect(suggestBucket([s]).map((r) => r.id)).toEqual(['steady']);
  });

  it('orders suggestions most severe first', () => {
    const sessions = [
      session('h1', day(1), [
        '## Task: One',
        '- Read(file_path=/a.ts)',
        '- Read(file_path=/b.ts)',
        '- Read(file_path=/c.ts)',
        '- Read(file_path=/d.ts)',
        '- ✗ Permission denied',
        '- ✗ Permission denied',
        '- done: ok',
      ]),
    ];
    const ids = suggestBucket(sessions).map((r) => r.severity);
    expect(ids[0]).toBe('high');
  });

  it('returns nothing for an empty bucket', () => {
    expect(suggestBucket([])).toEqual([]);
  });
});

describe('sessionSuggestionBuckets', () => {
  it('numbers windows from the oldest session and lists the newest bucket first', () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(`s${String(i).padStart(2, '0')}`, day(i + 1), ['## Task: One', '- Edit(file_path=/a.ts)', '- done: ok']),
    );
    const buckets = sessionSuggestionBuckets(sessions);
    expect(buckets.map((b) => b.label)).toEqual(['11–12', '1–10']);
    expect(buckets[1]!.index).toBe(1);
    expect(buckets[1]!.threadIds[0]).toBe('s00');
    expect(buckets[0]!.stats.sessions).toBe(2);
    expect(buckets[0]!.startedFirst).toBe(day(11));
  });

  it('has no buckets when there are no sessions', () => {
    expect(sessionSuggestionBuckets([])).toEqual([]);
  });
});

describe('summarizeBreakdownPatterns', () => {
  const input = (threadId: string, toolBytes: number): BucketBreakdownInput => ({
    threadId,
    file: `${threadId}.request.txt`,
    realInput: 1_000,
    breakdown: {
      totalBytes: 1_000,
      systemBytes: 200,
      toolsBytes: toolBytes,
      toolCount: 1,
      messageCount: 1,
      tools: [{ index: 0, name: 'Workflow', bytes: toolBytes, estTokens: toolBytes / 4 }],
      messages: [{ index: 0, role: 'user', bytes: 300, estTokens: 75 }],
    },
  });

  it('rolls regions and tool schemas up across requests, largest first', () => {
    const summary = summarizeBreakdownPatterns([input('a', 400), input('b', 500)]);
    expect(summary.requests).toBe(2);
    expect(summary.avgToolsBytes).toBe(450);
    const workflow = summary.patterns.find((p) => p.name === 'Workflow');
    expect(workflow).toMatchObject({ kind: 'tool', requests: 2, avgBytes: 450 });
    expect(workflow!.avgPctOfRequest).toBe(45);
    expect(summary.patterns[0]!.avgBytes).toBeGreaterThanOrEqual(summary.patterns[1]!.avgBytes);
  });

  it('is empty rather than NaN with no inputs', () => {
    const summary = summarizeBreakdownPatterns([]);
    expect(summary).toMatchObject({ requests: 0, avgTotalBytes: 0, maxRealInput: 0, patterns: [] });
  });

  it('flags schemas that dominate the request and a tool present in every one', () => {
    const suggestions = suggestFromBreakdown(summarizeBreakdownPatterns([input('a', 500), input('b', 500)]));
    expect(suggestions.map((s) => s.id).sort()).toEqual(['bucket-constant-tool', 'bucket-tool-schema-heavy']);
    const constant = suggestions.find((s) => s.id === 'bucket-constant-tool')!;
    expect(constant.title).toContain('Workflow');
    expect(constant.sources).toHaveLength(2);
  });

  it('names the requests the schema-heavy claim was measured from', () => {
    const summary = summarizeBreakdownPatterns([input('a', 400), input('b', 500)]);
    expect(summary.toolsSources.map((s) => s.threadId)).toEqual(['b', 'a']); // heaviest first

    const heavy = suggestFromBreakdown(summary).find((s) => s.id === 'bucket-tool-schema-heavy')!;
    expect(heavy.sources.map((s) => s.threadId)).toEqual(['b', 'a']);
    expect(heavy.sources.map((s) => s.label)).toEqual(['b.request.txt', 'a.request.txt']);
    expect(heavy.sources[0]!.sample).toBe('500 bytes of tool schemas');
  });

  it('suggests nothing from an empty breakdown', () => {
    expect(suggestFromBreakdown(summarizeBreakdownPatterns([]))).toEqual([]);
  });
});
