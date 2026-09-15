import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readRequestBodyParsed } from '../src/logs.js';

/**
 * A zero-byte `.request.txt` is a real state on disk: the proxy used to write a
 * full triple for bodyless health probes aimed at its port, so ~1.8% of archived
 * captures hold nothing — 32 of 2,735 on 2026-07-28, 23 of 1,281 on 2026-09-11.
 * Through `JSON.parse` those read as `Unexpected end of JSON input`, which is
 * what a corrupt file says too. These pin the message that tells the two apart,
 * on every path a body is read from.
 */

const run = promisify(execFile);

const FILE = '2026-07-20T13-31-00-278_anthropic';
const DAY = '2026-07-20';

/** The bundle is written by the same two tools that read it; skip where absent. */
const HAS_TOOLS = await run('zstd', ['--version'])
  .then(() => true)
  .catch(() => false);

async function corpus(): Promise<{ logDir: string; dayDir: string }> {
  const logDir = await mkdtemp(path.join(tmpdir(), 'empty-body-'));
  const dayDir = path.join(logDir, 'archive', DAY);
  await mkdir(dayDir, { recursive: true });
  return { logDir, dayDir };
}

/** The sidecar retention keeps forever, beside whatever became of the body. */
async function writeSidecar(dir: string, file: string): Promise<void> {
  const body = {
    timestamp: `${DAY}T13:31:00.278Z`,
    model: 'unknown',
    endpoint: 'HEAD /api/hello',
    statusCode: 200,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 },
    request: { toolCount: 0, toolsBytes: 0, systemBytes: 0, totalBytes: 2 },
    tools: [],
  };
  await writeFile(path.join(dir, `${file}.audit.json`), JSON.stringify(body), 'utf8');
}

/** Pack the named bodies exactly as the nightly job does, contents and all. */
async function writeBundle(dayDir: string, members: Record<string, string>): Promise<void> {
  const stage = await mkdtemp(path.join(tmpdir(), 'empty-body-stage-'));
  const names: string[] = [];
  for (const [file, text] of Object.entries(members)) {
    const name = `${file}.request.txt`;
    await writeFile(path.join(stage, name), text, 'utf8');
    names.push(name);
  }
  const out = path.join(dayDir, 'bodies.tar.zst');
  await run('sh', ['-c', `tar -cf - -C "${stage}" ${names.join(' ')} | zstd -q --long=27 -o "${out}"`]);
}

describe('a captured body that holds nothing', () => {
  it('names itself rather than reading as broken JSON, in the live directory', async () => {
    const { logDir } = await corpus();
    await writeSidecar(logDir, FILE);
    await writeFile(path.join(logDir, `${FILE}.request.txt`), '', 'utf8');

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/request body empty/);
  });

  it('names itself in an archived day whose bodies are still loose', async () => {
    const { logDir, dayDir } = await corpus();
    await writeSidecar(dayDir, FILE);
    await writeFile(path.join(dayDir, `${FILE}.request.txt`), '', 'utf8');

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/request body empty/);
  });

  it('counts a whitespace-only capture as empty as well', async () => {
    const { logDir } = await corpus();
    await writeSidecar(logDir, FILE);
    await writeFile(path.join(logDir, `${FILE}.request.txt`), '  \n\t ', 'utf8');

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/request body empty/);
  });

  it('is told apart from a corrupt capture, which keeps the parser its own message', async () => {
    const { logDir } = await corpus();
    await writeSidecar(logDir, FILE);
    await writeFile(path.join(logDir, `${FILE}.request.txt`), '{"messages": [', 'utf8');

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/JSON/);
    await expect(readRequestBodyParsed(logDir, FILE)).rejects.not.toThrow(/request body empty/);
  });

  it.skipIf(!HAS_TOOLS)('names itself when the empty capture is packed into the day bundle', async () => {
    const { logDir, dayDir } = await corpus();
    await writeSidecar(dayDir, FILE);
    // The days that hold empty captures were packed before the proxy stopped
    // writing them, so the bundles carry zero-byte members for good.
    await writeBundle(dayDir, { [FILE]: '' });

    await expect(readRequestBodyParsed(logDir, FILE)).rejects.toThrow(/request body empty/);
  });
});
