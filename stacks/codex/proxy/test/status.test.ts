import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ProxyStatusWriter } from '../src/status.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('recovers later lifecycle transitions after a transient filesystem failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-proxy-status-'));
  directories.push(directory);
  const blockedParent = join(directory, 'blocked');
  const statusPath = join(blockedParent, 'proxy-status.json');
  await writeFile(blockedParent, 'temporarily not a directory');
  const writer = new ProxyStatusWriter(statusPath, '127.0.0.1', 8787, 42);

  await assert.rejects(writer.write('startup'));
  await rm(blockedParent);
  await writer.write('ready');

  assert.deepEqual(JSON.parse(await readFile(statusPath, 'utf8')), {
    schemaVersion: 1,
    state: 'ready',
    updatedAt: JSON.parse(await readFile(statusPath, 'utf8')).updatedAt,
    pid: 42,
    listen: { host: '127.0.0.1', port: 8787 },
    upstreamErrorCount: 0,
  });
});
