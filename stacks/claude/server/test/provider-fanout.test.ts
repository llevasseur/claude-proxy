import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregateFanout, availableData, unavailableProviders } from '@agent-proxy/claude-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, resolveDbPath } from '../src/db/open.js';
import {
  fanOutProviders,
  ProviderUnreachableError,
  readProviderStore,
  type StoreReadFailure,
  sqliteFaultFrom,
} from '../src/db/provider-fanout.js';

/**
 * The reader side of ADR 0060, against real files.
 *
 * Every case here is one of the ticket's own criteria, and the three that carry
 * the most weight are about what does **not** happen: a healthy store with no
 * rows is not reported as absent, an unreachable server is not reported as an
 * unreadable store, and one broken store does not cost the other two providers
 * their data.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provider-fanout-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store that exists, has claude's schema, and holds nothing. */
function emptyStore(logDir: string): string {
  const db = openDb(logDir);
  db.close();
  return resolveDbPath(logDir);
}

describe('a store that was never created', () => {
  it('is store-absent with null data, not zero', async () => {
    const missing = path.join(dir, 'never-ran.db');
    const envelope = await readProviderStore({
      provider: 'openai',
      storePath: missing,
      read: () => [1, 2, 3],
    });
    expect(envelope.data).toBeNull();
    expect(envelope.unavailableReason).toMatchObject({ code: 'store-absent', provider: 'openai', path: missing });
  });

  it('does not attempt the read at all', async () => {
    let attempted = false;
    await readProviderStore({
      provider: 'openai',
      storePath: path.join(dir, 'never-ran.db'),
      read: () => {
        attempted = true;
        return [];
      },
    });
    expect(attempted).toBe(false);
  });
});

describe('a store that exists but cannot be read', () => {
  it('is store-unreadable, with the fault named', async () => {
    const broken = path.join(dir, 'broken.db');
    await writeFile(broken, 'this is not a database at all', 'utf8');
    const envelope = await readProviderStore({
      provider: 'anthropic',
      storePath: broken,
      read: () => {
        throw new Error('SQLITE_NOTADB: file is not a database');
      },
    });
    expect(envelope.data).toBeNull();
    expect(envelope.unavailableReason).toMatchObject({ code: 'store-unreadable', fault: 'corrupt' });
  });

  it('is a different reason from a store that was never created', async () => {
    const broken = path.join(dir, 'broken.db');
    await writeFile(broken, 'garbage', 'utf8');
    const unreadable = await readProviderStore({
      provider: 'anthropic',
      storePath: broken,
      read: () => {
        throw new Error('database disk image is malformed');
      },
    });
    const absent = await readProviderStore({
      provider: 'anthropic',
      storePath: path.join(dir, 'gone.db'),
      read: () => [],
    });
    expect(unreadable.unavailableReason?.code).not.toBe(absent.unavailableReason?.code);
  });
});

describe('a healthy store with no rows in range', () => {
  it('is a real measurement of zero, on the available branch', async () => {
    const storePath = emptyStore(dir);
    const envelope = await readProviderStore<readonly number[]>({
      provider: 'anthropic',
      storePath,
      read: () => [],
    });
    expect(envelope.unavailableReason).toBeNull();
    expect(envelope.data).toEqual([]);
  });
});

describe('a fault outside the store', () => {
  it('is provider-unreachable, never store-unreadable', async () => {
    const envelope = await readProviderStore({
      provider: 'ox-alpha',
      storePath: null,
      read: () => {
        throw new ProviderUnreachableError('http://127.0.0.1:8808', 'connect ECONNREFUSED 127.0.0.1:8808');
      },
    });
    expect(envelope.unavailableReason).toMatchObject({
      code: 'provider-unreachable',
      origin: 'http://127.0.0.1:8808',
    });
  });

  it('reads differently from an unreadable store even for the same provider', async () => {
    const unreachable = await readProviderStore({
      provider: 'ox-alpha',
      read: () => {
        throw new ProviderUnreachableError('http://127.0.0.1:8808', 'ECONNREFUSED');
      },
    });
    const unreadable = await readProviderStore({
      provider: 'ox-alpha',
      read: () => {
        throw new Error('database is locked');
      },
    });
    expect(unreachable.unavailableReason?.code).toBe('provider-unreachable');
    expect(unreadable.unavailableReason?.code).toBe('store-unreadable');
  });
});

describe('sqliteFaultFrom', () => {
  const failure = (message: string, code = ''): StoreReadFailure => ({ message, code });

  it('separates locked, corrupt and mid-migration from unknown', () => {
    expect(sqliteFaultFrom(failure('database is locked', 'SQLITE_BUSY'))).toBe('locked');
    expect(sqliteFaultFrom(failure('database disk image is malformed'))).toBe('corrupt');
    expect(sqliteFaultFrom(failure('file is not a database', 'SQLITE_NOTADB'))).toBe('corrupt');
    expect(sqliteFaultFrom(failure('no such table: request'))).toBe('migrating');
    expect(sqliteFaultFrom(failure('something else entirely'))).toBe('unknown');
  });

  it('reads the driver code as well as the message', () => {
    expect(sqliteFaultFrom(failure('constraint failed', 'SQLITE_LOCKED'))).toBe('locked');
  });
});

describe('a fan-out over three providers', () => {
  it('does not let one unreadable store take down the other two', async () => {
    const healthy = emptyStore(dir);
    const envelopes = await fanOutProviders<readonly number[]>([
      { provider: 'anthropic', storePath: healthy, read: () => [1, 2] },
      {
        provider: 'openai',
        read: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      },
      { provider: 'ox-alpha', read: () => [4] },
    ]);
    expect(availableData(envelopes)).toEqual([[1, 2], [4]]);
    expect(unavailableProviders(envelopes)).toEqual(['openai']);
    expect(envelopes[1]?.unavailableReason).toMatchObject({ code: 'store-unreadable', fault: 'locked' });
  });

  it('returns one envelope per source, in order, never a bare gap', async () => {
    const envelopes = await fanOutProviders<readonly number[]>([
      { provider: 'anthropic', storePath: path.join(dir, 'gone.db'), read: () => [] },
      { provider: 'openai', read: () => [] },
    ]);
    expect(envelopes.map((envelope) => envelope.provider)).toEqual(['anthropic', 'openai']);
    for (const envelope of envelopes) {
      expect(envelope.data === null).toBe(envelope.unavailableReason !== null);
    }
  });

  it('propagates rather than silently dropping a provider from the aggregate', async () => {
    const envelopes = await fanOutProviders<readonly number[]>([
      { provider: 'anthropic', read: () => [1, 2] },
      {
        provider: 'openai',
        read: () => {
          throw new Error('database is locked');
        },
      },
      { provider: 'ox-alpha', read: () => [4] },
    ]);
    const aggregate = aggregateFanout(envelopes, (rows) => rows.flat().reduce((sum, row) => sum + row, 0));
    expect(aggregate.value).toBeNull();
    expect(aggregate.unavailableReason).toMatchObject({ code: 'fanout-incomplete', providers: ['openai'] });
  });

  it('aggregates a fully-available fan-out, zeroes included', async () => {
    const envelopes = await fanOutProviders<readonly number[]>([
      { provider: 'anthropic', read: () => [] },
      { provider: 'openai', read: () => [] },
    ]);
    const aggregate = aggregateFanout(envelopes, (rows) => rows.flat().reduce((sum, row) => sum + row, 0));
    expect(aggregate).toEqual({ value: 0, unavailableReason: null });
  });
});
