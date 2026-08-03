/**
 * Unit tests for the live usage poll. Zero-dependency — Node's built-in runner,
 * which strips the types itself.
 *
 * Run:  node --test proxy/usage-live.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type FetchLike, hasAuth, LIVE_USAGE_FILE, noteAuth, pollOnce, resetAuth } from './usage-live.ts';

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-live-'));
const readOut = (dir: string): { fetchedAt?: string; payload?: unknown } =>
  JSON.parse(fs.readFileSync(path.join(dir, LIVE_USAGE_FILE), 'utf8'));

const okFetch =
  (payload: unknown): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => payload });

test('remembers an OAuth bearer and ignores an API key', () => {
  resetAuth();
  noteAuth({ 'x-api-key': 'sk-ant-secret' });
  assert.equal(hasAuth(), false, 'an api-key account has real headers instead');

  noteAuth({ authorization: 'Bearer oauth-token', 'anthropic-beta': 'oauth-2025-04-20' });
  assert.equal(hasAuth(), true);
});

test('sends the remembered credentials and writes only the numbers', async () => {
  resetAuth();
  noteAuth({ authorization: 'Bearer oauth-token', 'anthropic-beta': 'oauth-2025-04-20' });
  const dir = tmpDir();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const wrote = await pollOnce(dir, async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return { ok: true, status: 200, json: async () => [{ kind: 'five_hour', percent: 10 }] };
  });

  assert.equal(wrote, true);
  const call = calls[0];
  if (!call) throw new Error('the poll never called fetch');
  assert.equal(call.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(call.headers.authorization, 'Bearer oauth-token');
  assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');

  const out = readOut(dir);
  assert.deepEqual(out.payload, [{ kind: 'five_hour', percent: 10 }]);
  assert.ok(out.fetchedAt);
  // The credential must never reach disk.
  assert.equal(fs.readFileSync(path.join(dir, LIVE_USAGE_FILE), 'utf8').includes('oauth-token'), false);
});

test('writes nothing until a request has handed it a token', async () => {
  resetAuth();
  const dir = tmpDir();
  assert.equal(await pollOnce(dir, okFetch([])), false);
  assert.equal(fs.existsSync(path.join(dir, LIVE_USAGE_FILE)), false);
});

test('keeps the last good reading when a poll fails', async () => {
  resetAuth();
  noteAuth({ authorization: 'Bearer oauth-token' });
  const dir = tmpDir();
  await pollOnce(dir, okFetch([{ kind: 'seven_day', percent: 7 }]));

  // A stale reading still carries the reset instant the estimate anchors to,
  // so a failure must not clear it.
  assert.equal(await pollOnce(dir, async () => ({ ok: false, status: 500, json: async () => ({}) })), false);
  assert.deepEqual(readOut(dir).payload, [{ kind: 'seven_day', percent: 7 }]);

  assert.equal(
    await pollOnce(dir, async () => {
      throw new Error('network down');
    }),
    false,
  );
  assert.deepEqual(readOut(dir).payload, [{ kind: 'seven_day', percent: 7 }]);
});
