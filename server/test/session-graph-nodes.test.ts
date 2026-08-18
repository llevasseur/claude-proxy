// `threadIdForBody` only works if it agrees with the proxy function that named the
// transcript, so it is checked against that function itself rather than a golden hash.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../proxy/json.ts';
import { threadIdFor } from '../../proxy/session.ts';
import { buildSessionGraphNodes } from '../src/api.js';
import { listSessionGraphs, threadIdForBody } from '../src/sessions.js';

const CASES: { name: string; messages: JsonValue[] }[] = [
  { name: 'a plain string prompt', messages: [{ role: 'user', content: 'Fix the login bug' }] },
  {
    name: 'a block-array prompt',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    ],
  },
  {
    name: 'a first turn carrying only a tool result',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: 'stale output' }] },
      { role: 'user', content: 'the real root' },
    ],
  },
  { name: 'no user text at all', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] },
];

describe('threadIdForBody', () => {
  for (const { name, messages } of CASES) {
    it(`hashes ${name} to the same id the proxy does`, () => {
      expect(threadIdForBody('sess-1', messages)).toBe(threadIdFor('sess-1', messages));
    });
  }

  it('agrees with the proxy that a missing session id still names a thread', () => {
    const messages = [{ role: 'user', content: 'Fix the login bug' }];
    expect(threadIdForBody(null, messages)).toBe(threadIdFor(null, messages));
    expect(threadIdForBody(null, messages)).not.toBe(threadIdForBody('sess-1', messages));
  });

  it('is null for a body with nothing to root on', () => {
    expect(threadIdForBody('sess-1', [])).toBeNull();
    expect(threadIdForBody('sess-1', undefined)).toBeNull();
    expect(threadIdFor('sess-1', [])).toBeNull();
  });
});

// A session opened after midnight UTC but before it in the reporting zone: the transcript's
// `started` reads 07-29 while every request it makes reports on 07-28, so a scan floor taken
// straight off that UTC prefix puts the whole family outside the window.
const SESSION = 'be4b71b3-ccaf-4350-b1aa-b0cf0218897a';
const BODY = {
  messages: [
    { role: 'user', content: 'Fix the login bug' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test --runInBand --verbose' } }],
    },
  ],
};
const THREAD = threadIdFor(SESSION, BODY.messages)!;
const STAMP = '2026-07-29T02-41-00-000Z_anthropic';

async function afterMidnightUtc() {
  const dir = await mkdtemp(path.join(tmpdir(), 'graph-nodes-'));
  await mkdir(path.join(dir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(dir, 'sessions', `${THREAD}.md`),
    [
      `# Session ${THREAD}`,
      '- model: claude-opus-5',
      `- session: ${SESSION}`,
      '- started: 2026-07-29T02:41:00.000Z',
      '',
      '## Task: Fix the login bug',
      '- Bash(command=npm test --runInBand…)',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(dir, `${STAMP}.audit.json`),
    JSON.stringify({
      timestamp: '2026-07-29T02:41:00.000Z',
      model: 'claude-opus-5',
      session: { sessionId: SESSION },
      tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, realInput: 4000 },
      request: { toolCount: 1, toolsBytes: 100, systemBytes: 200, totalBytes: 3000 },
      tools: [],
    }),
  );
  await writeFile(path.join(dir, `${STAMP}.request.txt`), JSON.stringify(BODY));
  return dir;
}

describe('buildSessionGraphNodes', () => {
  it('rejects a thread id no transcript claims', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'graph-nodes-'));
    await expect(buildSessionGraphNodes(dir, 'deadbeefdeadbeef')).rejects.toThrow(
      'session not found: deadbeefdeadbeef',
    );
  });

  it('finds the requests of a session whose start falls on the far side of the reporting day', async () => {
    const dir = await afterMidnightUtc();
    const { threads, transcripts } = await buildSessionGraphNodes(dir, THREAD, new Date('2026-07-29T03:00:00.000Z'));

    expect(threads.map((t) => t.threadId)).toEqual([THREAD]);
    // And the steps come back whole.
    expect(threads[0]?.nodes.map((n) => n.text)).toEqual([
      'Fix the login bug',
      'Bash(command=npm test --runInBand --verbose)',
    ]);
    expect(threads[0]?.nodes.map((n) => n.message)).toEqual([0, 1]);
    // The family's gisted transcript streams ride along, since the graph index omits them.
    expect(transcripts.map((t) => t.threadId)).toEqual([THREAD]);
    expect(transcripts[0]?.nodes.map((n) => n.text)).toEqual([
      'Fix the login bug',
      'Bash(command=npm test --runInBand…)',
    ]);
  });
});

/** Two children of one parent, one carrying the proxy's record and one written before it. */
async function recordedAndLegacy() {
  const dir = await mkdtemp(path.join(tmpdir(), 'graph-recorded-'));
  const sessions = path.join(dir, 'sessions');
  await mkdir(sessions, { recursive: true });

  const parent = '00000000000000a1';
  await writeFile(
    path.join(sessions, `${parent}.md`),
    [
      `# Session ${parent}`,
      '- model: claude-opus-5',
      '- session: s-1',
      '- started: 2026-07-29T10:00:00.000Z',
      '',
      '## Task: Fan out', // 0
      '- Agent(subagent_type=Explore)', // 1
      '- Agent(subagent_type=general-purpose)', // 2
      '- done: both back', // 3
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(sessions, `${parent}.nodes.jsonl`),
    `${JSON.stringify({ i: 1, argsHash: 'aaaabbbbccccdddd' })}\n`,
  );

  // Started *later* than the other child, so the start-time guess would pair it with
  // the second spawn. Its own header says otherwise.
  await writeFile(
    path.join(sessions, '00000000000000b2.md'),
    [
      '# Session 00000000000000b2',
      '- model: claude-opus-5',
      '- session: s-1',
      '- started: 2026-07-29T10:00:20.000Z',
      `- parent: ${parent}`,
      '- spawn: 1',
      '- agent: Explore',
      '',
      '## Task: Recorded',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(sessions, '00000000000000c3.md'),
    [
      '# Session 00000000000000c3',
      '- model: claude-opus-5',
      '- session: s-1',
      '- started: 2026-07-29T10:00:10.000Z',
      '',
      '## Task: Legacy',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('listSessionGraphs', () => {
  it('links a child from its recorded header, and still infers for one that has none', async () => {
    const graphs = await listSessionGraphs(await recordedAndLegacy());
    const by = new Map(graphs.map((g) => [g.threadId, g]));

    expect(by.get('00000000000000b2')).toMatchObject({
      parentThreadId: '00000000000000a1',
      spawnIndex: 1,
      agentType: 'Explore',
      inferred: false,
    });
    // The record took spawn 1, so the guess only has spawn 2 left for the legacy child.
    expect(by.get('00000000000000c3')).toMatchObject({
      parentThreadId: '00000000000000a1',
      spawnIndex: 2,
      agentType: 'general-purpose',
      inferred: true,
    });
    // Children are listed in spawn order, not start order.
    expect(by.get('00000000000000a1')?.childThreadIds).toEqual(['00000000000000b2', '00000000000000c3']);
    // The parent's fingerprint sidecar rode along with its nodes.
    expect(by.get('00000000000000a1')?.nodes.map((n) => n.argsHash)).toEqual([null, 'aaaabbbbccccdddd', null, null]);
    // `recorded` is an input to the linker, not part of the wire shape.
    expect('recorded' in by.get('00000000000000b2')!).toBe(false);
  });
});
