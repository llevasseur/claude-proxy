import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.js';

/**
 * The nightly `maintain` run writes to the same database claude-server holds, and
 * the installed agent fires at 21:07 — when the server is normally up. WAL lets a
 * reader and a writer share the file; it does not make two writers concurrent.
 *
 * The wait is per handle, not a property of the database: the same wait inside
 * the server would block its synchronous event loop. These pin both halves —
 * the default stays 0, and the opt-in reaches SQLite.
 */

async function logDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'busy-timeout-'));
}

/** `PRAGMA busy_timeout` answers one row holding the current value in ms. */
function busyTimeoutOf(db: ReturnType<typeof openDb>): number {
  // SAFETY: the pragma answers a single row whose single column SQLite names
  // `timeout`, which is what this row type declares.
  const row = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
  return Number(row?.timeout ?? 0);
}

describe('opening the substrate with a busy timeout', () => {
  it('leaves the server on the SQLite default of no wait', async () => {
    const db = openDb(await logDir());
    try {
      expect(busyTimeoutOf(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('applies the wait a second writer asks for', async () => {
    const db = openDb(await logDir(), { busyTimeoutMs: 20_000 });
    try {
      expect(busyTimeoutOf(db)).toBe(20_000);
    } finally {
      db.close();
    }
  });
});
