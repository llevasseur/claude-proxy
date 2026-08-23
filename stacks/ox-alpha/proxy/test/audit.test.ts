import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  estimateUsageCost,
  normalizeResponsesUsage,
  parseSanitizedAuditSidecar,
} from '../../packages/core/src/index.ts';
import { writeSanitizedSidecarAtomically } from '../src/audit.ts';
import { makeSidecar } from '../src/observe.ts';

function candidate(): ReturnType<typeof makeSidecar> {
  const usage = normalizeResponsesUsage({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 10 },
    total_tokens: 150,
  });
  return makeSidecar({
    endpoint: '/v1/responses',
    responseStatus: 200,
    requestId: 'req-1',
    identity: { model: 'gpt-5', usage },
    recordId: '11111111-2222-4333-8444-555555555555',
    timestamp: '2026-08-22T12:00:00.000Z',
  });
}

test('sidecar write is atomic: temp file in same directory, then rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ox-alpha-audit-test-'));
  const observations: string[] = [];

  await writeSanitizedSidecarAtomically(directory, candidate(), {
    beforeRename: async (temporaryPath) => {
      assert.ok(temporaryPath.startsWith(`${directory}/`), 'temp file lives in the target directory');
      assert.match(temporaryPath, /\.tmp$/, 'temporary name ends in .tmp');
      await assert.rejects(
        stat(join(directory, '2026-08-22T12-00-00.000Z_11111111-2222-4333-8444-555555555555.audit.json')),
      );
      observations.push(temporaryPath);
    },
  });

  const finalName = '2026-08-22T12-00-00.000Z_11111111-2222-4333-8444-555555555555.audit.json';
  const files = await readdir(directory);
  assert.deepEqual(files, [finalName], 'no temporary residue remains');
  assert.equal(observations.length, 1);

  const parsed = parseSanitizedAuditSidecar(JSON.parse(await readFile(join(directory, finalName), 'utf8')));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.cost?.amountUsd, '0.0006025');
});

test('an invalid sidecar candidate is rejected before any file is created', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ox-alpha-audit-test-'));
  const invalid = { ...candidate(), requestId: undefined } as unknown as ReturnType<typeof makeSidecar>;
  await assert.rejects(writeSanitizedSidecarAtomically(directory, invalid));
  assert.deepEqual(await readdir(directory), []);
});

test('unknown-model pricing still produces a valid sidecar with a typed reason', async () => {
  const usage = normalizeResponsesUsage({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  const sidecar = makeSidecar({
    endpoint: '/v1/responses',
    responseStatus: 200,
    requestId: null,
    identity: { model: 'mystery-model', usage },
    recordId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: '2026-08-22T13:30:00.000Z',
  });
  assert.equal(estimateUsageCost('mystery-model', usage).cost, null);
  const directory = await mkdtemp(join(tmpdir(), 'ox-alpha-audit-test-'));
  const finalPath = await writeSanitizedSidecarAtomically(directory, sidecar);
  const parsed = parseSanitizedAuditSidecar(JSON.parse(await readFile(finalPath, 'utf8')));
  assert.equal(parsed.cost, null);
  assert.deepEqual(parsed.costUnavailableReason, { code: 'unknown-model', model: 'mystery-model' });
});
