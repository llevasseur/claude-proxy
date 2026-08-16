/**
 * Unit tests for the skim cache's write-path eviction. Zero-dependency —
 * Node's built-in runner, which strips the types itself.
 *
 * Run:  node --test proxy/skim.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evict, lookup, store } from './skim.ts';

const SSE = '.sse';
const META = '.meta.json';

/** A throwaway cache directory per test; the runner's tmp is cleaned by the OS. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skim-evict-'));
}

/** Write one entry directly, with an explicit age in ms for both mtime and `storedAt`. */
function seed(dir: string, key: string, ageMs = 0): void {
  const at = Date.now() - ageMs;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}${SSE}`), `data: ${key}\n\n`);
  fs.writeFileSync(path.join(dir, `${key}${META}`), JSON.stringify({ statusCode: 200, storedAt: at }));
  const when = new Date(at);
  fs.utimesSync(path.join(dir, `${key}${SSE}`), when, when);
}

const keys = (dir: string): string[] =>
  fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(SSE))
    .map((n) => n.slice(0, -SSE.length))
    .sort();

const mtimeOf = (dir: string, key: string): number => fs.statSync(path.join(dir, `${key}${SSE}`)).mtimeMs;

test('store writes both files and leaves a fresh entry alone', () => {
  const dir = path.join(tmpDir(), 'nested'); // store mkdirs its own directory
  store(dir, 'aaa', { statusCode: 200, rawResponse: Buffer.from('data: hi\n\n') });

  assert.deepEqual(keys(dir), ['aaa']);
  assert.ok(fs.existsSync(path.join(dir, `aaa${META}`)));
  assert.deepEqual(lookup(dir, 'aaa')?.body.toString(), 'data: hi\n\n');
});

test('evict removes entries past the TTL and keeps the live ones', () => {
  const dir = tmpDir();
  seed(dir, 'fresh', 0);
  seed(dir, 'recent', 1_000);
  seed(dir, 'stale', 60_000);

  const removed = evict(dir, { ttlMs: 10_000, maxEntries: 100 });

  assert.equal(removed, 1);
  assert.deepEqual(keys(dir), ['fresh', 'recent']);
  assert.equal(fs.existsSync(path.join(dir, `stale${META}`)), false);
});

test('evict never removes an entry lookup would still serve', () => {
  const dir = tmpDir();
  seed(dir, 'live', 1_000);

  // Any positive TTL that keeps `live` readable must also keep it on disk.
  evict(dir, { ttlMs: 60_000, maxEntries: 100 });

  assert.deepEqual(keys(dir), ['live']);
  assert.ok(lookup(dir, 'live'));
});

test('evict enforces the count cap oldest-first', () => {
  const dir = tmpDir();
  seed(dir, 'oldest', 4_000);
  seed(dir, 'older', 3_000);
  seed(dir, 'newer', 2_000);
  seed(dir, 'newest', 1_000);

  const removed = evict(dir, { ttlMs: 600_000, maxEntries: 2 });

  assert.equal(removed, 2);
  assert.deepEqual(keys(dir), ['newer', 'newest']);
});

test('a lookup hit touches mtime, so the LRU order is use order not write order', () => {
  const dir = tmpDir();
  seed(dir, 'written-first', 4_000);
  seed(dir, 'written-second', 3_000);
  seed(dir, 'written-third', 2_000);

  const before = mtimeOf(dir, 'written-first');
  assert.ok(lookup(dir, 'written-first'), 'the oldest entry is still within the default TTL');
  assert.ok(mtimeOf(dir, 'written-first') > before, 'a hit moves mtime forward');

  // By write order `written-first` would go; by use order it is the newest.
  evict(dir, { ttlMs: 600_000, maxEntries: 1 });
  assert.deepEqual(keys(dir), ['written-first']);
});

test('a miss does not touch mtime', () => {
  const dir = tmpDir();
  seed(dir, 'expired', 1_000);
  // Rewrite the sidecar as long-expired while leaving mtime where it is.
  fs.writeFileSync(path.join(dir, `expired${META}`), JSON.stringify({ statusCode: 200, storedAt: 0 }));
  const before = mtimeOf(dir, 'expired');

  assert.equal(lookup(dir, 'expired'), null);
  assert.equal(mtimeOf(dir, 'expired'), before);
  assert.equal(lookup(dir, 'never-stored'), null);
});

test('evict removes an orphaned sidecar whose body is gone', () => {
  const dir = tmpDir();
  seed(dir, 'kept', 0);
  seed(dir, 'orphan', 0);
  fs.unlinkSync(path.join(dir, `orphan${SSE}`));

  const removed = evict(dir, { ttlMs: 600_000, maxEntries: 100 });

  assert.equal(removed, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`kept${META}`, `kept${SSE}`]);
});

test('store evicts on write and never removes the entry it just wrote', () => {
  const dir = tmpDir();
  seed(dir, 'a', 5_000);
  seed(dir, 'b', 4_000);
  process.env.SKIM_MAX_ENTRIES = '1';
  try {
    store(dir, 'c', { statusCode: 200, rawResponse: Buffer.from('data: c\n\n') });
  } finally {
    delete process.env.SKIM_MAX_ENTRIES;
  }

  assert.deepEqual(keys(dir), ['c']);
  assert.ok(lookup(dir, 'c'));
});

test('a junk or non-positive SKIM_MAX_ENTRIES falls back to the default bound', () => {
  const dir = tmpDir();
  seed(dir, 'a', 5_000);
  seed(dir, 'b', 4_000);
  for (const value of ['0', '-1', 'lots']) {
    process.env.SKIM_MAX_ENTRIES = value;
    try {
      assert.equal(evict(dir, { ttlMs: 600_000 }), 0, `SKIM_MAX_ENTRIES=${value} must not empty the cache`);
    } finally {
      delete process.env.SKIM_MAX_ENTRIES;
    }
  }
  assert.deepEqual(keys(dir), ['a', 'b']);
});

test('evict on a directory that does not exist is a no-op rather than a throw', () => {
  assert.equal(evict(path.join(tmpDir(), 'absent'), { ttlMs: 1, maxEntries: 1 }), 0);
});
