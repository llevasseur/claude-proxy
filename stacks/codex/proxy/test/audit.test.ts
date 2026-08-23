import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { parseSanitizedAuditSidecar, type SanitizedAuditSidecarV1 } from '../../packages/core/src/index.ts';
import { writeSanitizedSidecarAtomically } from '../src/audit.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-proxy-audit-'));
  directories.push(directory);
  return directory;
}

function sidecar(): SanitizedAuditSidecarV1 {
  return {
    schemaVersion: 1,
    recordId: 'record-1',
    timestamp: '2026-08-19T12:00:00.000Z',
    model: 'gpt-5',
    endpoint: '/v1/responses',
    responseStatus: 200,
    requestId: 'request-1',
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 130,
    },
    cost: { currency: 'USD', amountUsd: '0.000405', catalogueVersion: 'test' },
    costUnavailableReason: null,
  };
}

test('flushes a schema-valid sidecar before atomically publishing its final name', async () => {
  const directory = await temporaryDirectory();
  let observedTemporaryPath = '';
  const finalPath = await writeSanitizedSidecarAtomically(directory, sidecar(), {
    async beforeRename(temporaryPath, expectedFinalPath) {
      observedTemporaryPath = temporaryPath;
      assert.match(temporaryPath, /\.tmp$/);
      assert.match(expectedFinalPath, /\.audit\.json$/);
      assert.deepEqual(parseSanitizedAuditSidecar(JSON.parse(await readFile(temporaryPath, 'utf8'))), sidecar());
    },
  });

  assert.notEqual(observedTemporaryPath, '');
  assert.deepEqual(parseSanitizedAuditSidecar(JSON.parse(await readFile(finalPath, 'utf8'))), sidecar());
  assert.deepEqual(await readdir(directory), ['2026-08-19T12-00-00.000Z_record-1.audit.json']);
});

test('an interruption before rename leaves no partial final sidecar', async () => {
  const directory = await temporaryDirectory();
  await assert.rejects(
    writeSanitizedSidecarAtomically(directory, sidecar(), {
      beforeRename() {
        throw new Error('simulated interruption');
      },
    }),
    /simulated interruption/,
  );

  const names = await readdir(directory);
  assert.equal(
    names.some((name) => name.endsWith('.audit.json')),
    false,
  );
  assert.equal(names.length, 1);
  assert.match(names[0]!, /\.tmp$/);
  assert.deepEqual(
    parseSanitizedAuditSidecar(JSON.parse(await readFile(join(directory, names[0]!), 'utf8'))),
    sidecar(),
  );
});
