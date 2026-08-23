// A dashboard Stop leaves no trace on the wire, so the server records it on the
// transcript; the graph reads it back as the cut that opens a side trail.
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSessionNodes } from '@agent-proxy/claude-core';
import { describe, expect, it } from 'vitest';
import { recordInterruption } from '../src/chat.js';
import { resolveSessionsDir } from '../src/sessions.js';

const THREAD = 'ab3167129339d34f';

const TRANSCRIPT = [
  '',
  `# Session ${THREAD}`,
  '- model: claude-opus-5',
  '',
  '## Task: Ship it',
  '- Bash(command=npm test)',
  '',
].join('\n');

async function logDirWithTranscript(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-interruption-'));
  const sessions = resolveSessionsDir(dir);
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${THREAD}.md`), TRANSCRIPT);
  return dir;
}

describe('recordInterruption', () => {
  it('appends the stop so the graph reads it back as a cut', async () => {
    const dir = await logDirWithTranscript();
    recordInterruption(dir, THREAD, 'stopped');

    const content = fs.readFileSync(path.join(resolveSessionsDir(dir), `${THREAD}.md`), 'utf8');
    expect(content).toContain('- interrupted: stopped');

    const nodes = parseSessionNodes(content);
    expect(nodes).toHaveLength(2); // the line is a flag on the step it cut, not a step
    expect(nodes[1]?.interrupted).toBe(true);
  });

  it('records each reason the CLI can report', async () => {
    const dir = await logDirWithTranscript();
    for (const why of ['stopped', 'timeout', 'limit'] as const) recordInterruption(dir, THREAD, why);

    const content = fs.readFileSync(path.join(resolveSessionsDir(dir), `${THREAD}.md`), 'utf8');
    expect(content).toContain('- interrupted: timeout');
    expect(content).toContain('- interrupted: limit');
  });

  it('skips a thread whose transcript the proxy has not flushed yet', async () => {
    const dir = await logDirWithTranscript();
    const missing = path.join(resolveSessionsDir(dir), '0000000000000000.md');
    recordInterruption(dir, '0000000000000000', 'stopped');
    // A headerless file would parse as a session with no model, session id, or start time.
    expect(fs.existsSync(missing)).toBe(false);
  });
});
