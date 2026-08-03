// These scans floor themselves at a session's own start, which `readSidecars`
// compares against *reporting* days — a floor sliced off the raw UTC instant
// excludes every request an evening session ever made.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { threadIdFor } from '../../proxy/session.ts';
import { buildSessionBreakdown, buildSessionSuggestionBucket } from '../src/api.js';

// 22:41 EDT on the 28th, but 02:41Z on the 29th.
const STARTED = '2026-07-29T02:41:00.000Z';
const NOW = new Date('2026-07-29T12:00:00.000Z');
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

let logDir: string;

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'request-floor-'));
  await mkdir(path.join(logDir, 'sessions'), { recursive: true });
  await writeFile(
    path.join(logDir, 'sessions', `${THREAD}.md`),
    [
      `# Session ${THREAD}`,
      '- model: claude-opus-5',
      `- session: ${SESSION}`,
      `- started: ${STARTED}`,
      '',
      '## Task: Fix the login bug',
      '- Bash(command=npm test --runInBand…)',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(logDir, `${STAMP}.audit.json`),
    JSON.stringify({
      timestamp: STARTED,
      model: 'claude-opus-5',
      session: { sessionId: SESSION },
      tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, realInput: 4000 },
      request: { toolCount: 1, toolsBytes: 100, systemBytes: 200, totalBytes: 3000 },
      tools: [],
    }),
  );
  await writeFile(path.join(logDir, `${STAMP}.request.txt`), JSON.stringify(BODY));
});

describe('a session that started in the Eastern evening', () => {
  it('still finds its own captures in the Request breakdown', async () => {
    const breakdown = await buildSessionBreakdown(logDir, THREAD, NOW);

    expect(breakdown.sessionId).toBe(SESSION);
    expect(breakdown.requestCount).toBe(1);
    expect(breakdown.peak?.realInput).toBe(4000);
  });

  it('still contributes its peak to its suggestion bucket', async () => {
    const { bucket, meta } = await buildSessionSuggestionBucket(logDir, 1, NOW);

    expect(bucket.startedFirst).toBe(STARTED);
    expect(meta.requestsMissing).toBe(0);
  });
});
