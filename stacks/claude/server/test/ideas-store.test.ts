/**
 * The client half of the hosted ideas ledger: what this device does when the
 * ledger is configured, unreachable, or not configured at all.
 *
 * The ledger's own rules are tested where they live — against real SQLite in
 * `services/concepts/test/ideas.test.ts`. What matters here is the refusal
 * behaviour ADR 0006 turns on: **an unconfigured device must fail loudly rather
 * than answering from a private copy.**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdeasStoreUnconfiguredError, RemoteIdeasStoreError, requireRemoteIdeasStore } from '../src/ideas-remote.js';
import {
  addIdeasToStore,
  claimIdeasInStore,
  commentIdeasInStore,
  fileIdeasInStore,
  markIdeasInStore,
  readIdeasStore,
  resolveIdeasPath,
} from '../src/ideas-store.js';
import { type FakeIdeasWorker, installFakeIdeasWorker } from './ideas-fake-worker.js';

let worker: FakeIdeasWorker;

beforeEach(() => {
  worker = installFakeIdeasWorker();
});

afterEach(() => {
  worker.restore();
});

const ADD = {
  slug: 'rolling-window',
  title: 'A rolling last-10 window beside the fixed buckets',
  rationale: 'The fixed windows split a habit that spans a boundary.',
  evidence: [{ source: 'open-question' as const, path: 'docs/features/session-suggestions.md' }],
  repo: 'llevasseur/claude-proxy',
  area: 'ui-ux',
};

describe('an unconfigured device', () => {
  /** Both variables cleared, which is what a machine that never set them looks like. */
  function unconfigured(): void {
    worker.restore();
    delete process.env.IDEAS_URL;
    delete process.env.IDEAS_TOKEN;
    delete process.env.CONCEPTS_URL;
    delete process.env.CONCEPTS_TOKEN;
  }

  it('refuses to read rather than answering from a local file', async () => {
    unconfigured();
    // The whole point of ADR 0006's first departure: silence here would mean a
    // second ledger that looks complete.
    await expect(readIdeasStore()).rejects.toThrow(IdeasStoreUnconfiguredError);
  });

  it('refuses every write, naming the variables that would fix it', async () => {
    unconfigured();
    for (const write of [
      () => addIdeasToStore([ADD]),
      () => markIdeasInStore([{ slug: 'rolling-window', status: 'accepted' as const }]),
      () => claimIdeasInStore([{ slug: 'rolling-window', by: 'run-a' }]),
      () => fileIdeasInStore([{ slug: 'rolling-window', area: 'services' }]),
      () => commentIdeasInStore([{ slug: 'rolling-window', text: 'x' }]),
    ]) {
      await expect(write()).rejects.toThrow(/IDEAS_URL and IDEAS_TOKEN/);
    }
  });

  it('says there is no local fallback, so the message cannot be read as a transient', async () => {
    unconfigured();
    await expect(readIdeasStore()).rejects.toThrow(/no local fallback/);
  });
});

describe('resolving the store', () => {
  it('falls back to the concepts address, since both datasets are one Worker behind one token', () => {
    worker.restore();
    delete process.env.IDEAS_URL;
    delete process.env.IDEAS_TOKEN;
    process.env.CONCEPTS_URL = 'https://operator.test/';
    process.env.CONCEPTS_TOKEN = 'shared';
    // The trailing slash is dropped, so a configured URL cannot double the separator.
    expect(requireRemoteIdeasStore()).toEqual({ origin: 'https://operator.test', token: 'shared' });
    delete process.env.CONCEPTS_URL;
    delete process.env.CONCEPTS_TOKEN;
  });

  it('reports where the ledger is, which is a URL rather than a path now', () => {
    expect(resolveIdeasPath()).toBe('https://ledger.test/api/ideas');
  });
});

describe('an unreachable ledger', () => {
  it('throws rather than reading as empty, since an empty ledger is a different fact', async () => {
    const realFetch = globalThis.fetch;
    // SAFETY: this stub only needs to satisfy the one call `readIdeasStore` makes
    // (no arguments read, one `Response` returned), never `fetch`'s full overload set.
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    try {
      await expect(readIdeasStore()).rejects.toThrow(RemoteIdeasStoreError);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('never puts the token in the error, only the origin and the path', async () => {
    const realFetch = globalThis.fetch;
    // SAFETY: same narrow stub as above — only the one call `readIdeasStore` makes
    // needs to be satisfied.
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    try {
      await readIdeasStore();
      expect.unreachable('the read should have thrown');
    } catch (error) {
      // SAFETY: `readIdeasStore` only ever rejects with `RemoteIdeasStoreError`
      // (an `Error` subclass), which the `try` above is asserting against.
      expect((error as Error).message).toContain('/api/ideas/export');
      // SAFETY: same `RemoteIdeasStoreError` as above — this checks the same
      // caught value's message for the token that must not appear in it.
      expect((error as Error).message).not.toContain('test-token');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the writes, against a ledger that answers', () => {
  it('round-trips an entry, and reports where it landed', async () => {
    const written = await addIdeasToStore([ADD]);
    expect(written.added).toEqual(['rolling-window']);
    expect(written.file).toBe('https://ledger.test/api/ideas');

    const store = await readIdeasStore();
    expect(store.ideas['rolling-window']?.title).toBe(ADD.title);
    expect(store.ideas['rolling-window']?.status).toBe('proposed');
  });

  it('returns the ledger as the server now holds it, not a local guess at it', async () => {
    await addIdeasToStore([ADD]);
    const marked = await markIdeasInStore([{ slug: 'rolling-window', status: 'accepted' }]);
    // The `store` a caller renders came back from the ledger after the write.
    expect(marked.store.ideas['rolling-window']?.status).toBe('accepted');
    expect(marked.updated).toEqual(['rolling-window']);
  });

  it('reports a refusal on a slug already on the shared ledger', async () => {
    await addIdeasToStore([ADD]);
    const again = await addIdeasToStore([{ ...ADD, title: 'Rewritten' }]);
    expect(again.refused).toEqual(['rolling-window']);
    expect(again.store.ideas['rolling-window']?.title).toBe(ADD.title);
  });

  it('carries the server-side near-duplicate check back to the caller', async () => {
    await addIdeasToStore([{ ...ADD, slug: 'rolling-window-view' }]);
    const next = await addIdeasToStore([{ ...ADD, slug: 'add-rolling-window' }]);
    // Computed against the whole shared corpus, which is what a device-local
    // ledger could not do.
    expect(next.similar['add-rolling-window']).toContain('rolling-window-view');
  });

  it('claims, and refuses a second holder with the holder named', async () => {
    await addIdeasToStore([ADD]);
    await markIdeasInStore([{ slug: 'rolling-window', status: 'accepted' }]);

    const claimed = await claimIdeasInStore([{ slug: 'rolling-window', by: 'feat/rolling-window' }]);
    expect(claimed.claimed).toEqual(['rolling-window']);
    expect(claimed.store.ideas['rolling-window']?.status).toBe('claimed');

    const second = await claimIdeasInStore([{ slug: 'rolling-window', by: 'someone-else' }]);
    expect(second.claimed).toEqual([]);
    expect(second.refused[0]?.heldBy).toBe('feat/rolling-window');
  });

  it('re-files without disturbing the decision, and comments without touching the note', async () => {
    await addIdeasToStore([ADD]);
    await markIdeasInStore([{ slug: 'rolling-window', status: 'rejected', note: 'not now' }]);

    const filed = await fileIdeasInStore([{ slug: 'rolling-window', area: 'infrastructure' }]);
    expect(filed.store.ideas['rolling-window']?.area).toBe('infrastructure');
    expect(filed.store.ideas['rolling-window']?.status).toBe('rejected');
    expect(filed.store.ideas['rolling-window']?.note).toBe('not now');

    const commented = await commentIdeasInStore([{ slug: 'rolling-window', text: 'start with the chart' }]);
    expect(commented.store.ideas['rolling-window']?.comment).toBe('start with the chart');
    expect(commented.store.ideas['rolling-window']?.note).toBe('not now');
  });
});
