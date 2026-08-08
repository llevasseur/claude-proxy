// The Context size table is searched by what was asked for, so every row has to
// carry the text a person typed — which lives with the transcript, not with the
// audit sidecar the row is built from.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promptMatches } from '@claude-proxy/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/api.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const SESSION = 'be4b71b3-ccaf-4350-b1aa-b0cf0218897a';

/** A `/task` prompt as the wire carries it: reminders, envelope, inlined definition. */
const TASK_ROOT =
  '<system-reminder>Contents of AGENTS.md: never commit on main.</system-reminder>' +
  '<command-message>task</command-message> <command-name>/task</command-name>' +
  '<command-args>Make the request breakdown searchable by plain text</command-args>' +
  ' Take a task from a plain-language description all the way to an open PR. Step 1 — Set up the workspace.';

const THREADS = {
  aaaa0000aaaa0001: TASK_ROOT,
  aaaa0000aaaa0002: 'Why did the artifact panel stop scrolling?',
  // A thread that sent requests before the proxy had a prompt to record.
  aaaa0000aaaa0003: null,
} as const;

let logDir: string;

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-prompt-'));
  await mkdir(path.join(logDir, 'sessions'), { recursive: true });

  let minute = 0;
  for (const [threadId, root] of Object.entries(THREADS)) {
    if (root) {
      await writeFile(path.join(logDir, 'sessions', `${threadId}.state.json`), JSON.stringify({ root }));
    }
    // Two captures per thread: one prompt has to reach every request it sent.
    for (const n of [0, 1]) {
      const stamp = `2026-07-29T09-${String(minute++).padStart(2, '0')}-00-000Z_anthropic`;
      await writeFile(
        path.join(logDir, `${stamp}.audit.json`),
        JSON.stringify({
          timestamp: `2026-07-29T09:${String(minute).padStart(2, '0')}:00.000Z`,
          model: 'claude-opus-5',
          session: { sessionId: SESSION, threadId },
          tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, realInput: 4000 + n },
          request: { toolCount: 1, toolsBytes: 100, systemBytes: 200, totalBytes: 3000 },
          tools: [],
        }),
      );
    }
  }
});

describe('the Context size requests table', () => {
  it('carries only the text a person typed, not the command definition around it', async () => {
    const { summary } = await buildContext(logDir, 7, NOW);
    const prompts = new Set(summary.entries.map((e) => e.prompt));

    expect(prompts).toContain('/task Make the request breakdown searchable by plain text');
    expect([...prompts].join(' ')).not.toContain('AGENTS.md');
    expect([...prompts].join(' ')).not.toContain('Set up the workspace');
  });

  it('gives every request of a thread the same prompt, and null when none was recorded', async () => {
    const { summary } = await buildContext(logDir, 7, NOW);

    const task = summary.entries.filter((e) => e.threadId === 'aaaa0000aaaa0001');
    expect(task).toHaveLength(2);
    expect(task.every((e) => e.prompt === '/task Make the request breakdown searchable by plain text')).toBe(true);
    expect(summary.entries.filter((e) => e.threadId === 'aaaa0000aaaa0003').every((e) => e.prompt === null)).toBe(true);
  });

  it('narrows to the requests whose prompt answers a plain-text query', async () => {
    const { summary } = await buildContext(logDir, 7, NOW);

    const found = summary.entries.filter((e) => promptMatches(e.prompt, 'SCROLLING panel'));
    expect(found.map((e) => e.threadId)).toEqual(['aaaa0000aaaa0002', 'aaaa0000aaaa0002']);
    expect(summary.entries.filter((e) => promptMatches(e.prompt, ''))).toHaveLength(6);
  });
});
