import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../src/json.js';
import { locateRequestBody, readRequestBodyParsed } from '../src/logs.js';

/**
 * Once an archived day's `.request.txt` bodies are packed into
 * `archive/<day>/bodies.tar.zst`, every body read used to fall through to
 * `evicted` — the sidecar is still there, the loose body is not. That reports a
 * body that exists as permanently gone, on every drill-down at once. These
 * cover the read path that unpacks it, and the three ways it can legitimately
 * fail without ever answering an empty body.
 */

const run = promisify(execFile);

const FILE = '2026-07-20T13-31-00-278_anthropic';
const DAY = '2026-07-20';

/** The bundle is written by the same two tools that read it; skip where absent. */
const HAS_TOOLS = await run('zstd', ['--version'])
  .then(() => true)
  .catch(() => false);

interface Corpus {
  logDir: string;
  dayDir: string;
}

async function corpus(): Promise<Corpus> {
  const logDir = await mkdtemp(path.join(tmpdir(), 'bundle-reads-'));
  const dayDir = path.join(logDir, 'archive', DAY);
  await mkdir(dayDir, { recursive: true });
  return { logDir, dayDir };
}

/** The sidecar retention keeps forever, beside whatever became of the body. */
async function writeSidecar(dir: string, file: string): Promise<void> {
  const body = {
    timestamp: `${DAY}T13:31:00.278Z`,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 },
    request: { toolCount: 0, toolsBytes: 0, systemBytes: 1200, totalBytes: 4000 },
    tools: [],
  };
  await writeFile(path.join(dir, `${file}.audit.json`), JSON.stringify(body), 'utf8');
}

/**
 * Pack the named bodies into `<dayDir>/bodies.tar.zst`, exactly as the retention
 * job does — one `tar` stream through `zstd --long=27` — so the fixture is a
 * real bundle rather than a committed binary.
 */
async function writeBundle(dayDir: string, members: Record<string, JsonValue>): Promise<void> {
  const stage = await mkdtemp(path.join(tmpdir(), 'bundle-stage-'));
  const names: string[] = [];
  for (const [file, body] of Object.entries(members)) {
    const name = `${file}.request.txt`;
    await writeFile(path.join(stage, name), JSON.stringify(body), 'utf8');
    names.push(name);
  }
  const out = path.join(dayDir, 'bodies.tar.zst');
  await run('sh', ['-c', `tar -cf - -C "${stage}" ${names.join(' ')} | zstd -q --long=27 -o "${out}"`]);
}

describe.skipIf(!HAS_TOOLS)('archived request bodies packed into a per-day bundle', () => {
  it('reads a body out of the bundle rather than reporting it evicted', async () => {
    const { logDir, dayDir } = await corpus();
    await writeSidecar(dayDir, FILE);
    await writeBundle(dayDir, { [FILE]: { model: 'claude-opus-5', messages: ['packed'] } });

    const location = await locateRequestBody(logDir, FILE);
    expect(location.status).toBe('compressed');

    const body = await readRequestBodyParsed(logDir, FILE);
    expect(body).toEqual({ model: 'claude-opus-5', messages: ['packed'] });
  });

  it('prefers a loose body over the bundle', async () => {
    const { logDir, dayDir } = await corpus();
    await writeSidecar(dayDir, FILE);
    await writeBundle(dayDir, { [FILE]: { messages: ['packed'] } });
    await writeFile(path.join(dayDir, `${FILE}.request.txt`), JSON.stringify({ messages: ['loose'] }), 'utf8');

    const location = await locateRequestBody(logDir, FILE);
    expect(location.status).toBe('present');

    const body = await readRequestBodyParsed(logDir, FILE);
    expect(body).toEqual({ messages: ['loose'] });
  });

  it('throws rather than answering an empty body when the bundle omits the member', async () => {
    const { logDir, dayDir } = await corpus();
    await writeSidecar(dayDir, FILE);
    // A bundle that holds some other capture from the same day.
    await writeBundle(dayDir, { '2026-07-20T09-00-00-000_anthropic': { messages: ['elsewhere'] } });

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/request body missing from bundle/);
  });

  it('throws rather than answering an empty body when the bundle will not decompress', async () => {
    const { logDir, dayDir } = await corpus();
    await writeSidecar(dayDir, FILE);
    await writeFile(path.join(dayDir, 'bodies.tar.zst'), 'not a zstd frame', 'utf8');

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/request body bundle unreadable/);
  });

  it('still reports evicted when the sidecar is alone, with no bundle', async () => {
    const { logDir, dayDir } = await corpus();
    await writeSidecar(dayDir, FILE);

    const location = await locateRequestBody(logDir, FILE);
    expect(location.status).toBe('evicted');

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/request body evicted/);
  });

  it('rejects a crafted file name before it can select a bundle member', async () => {
    const { logDir, dayDir } = await corpus();
    await writeBundle(dayDir, { [FILE]: { messages: ['packed'] } });

    await expect(readRequestBodyParsed(logDir, '../../etc/passwd')).rejects.toThrow(/invalid request file name/);
  });
});
