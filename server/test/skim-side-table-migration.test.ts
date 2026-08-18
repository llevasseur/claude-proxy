import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, resolveDbPath, SCHEMA_VERSION } from '../src/db/open.js';

// SAFETY: the same runtime require `open.ts` itself uses — `node:sqlite` is newer
// than the builtin list Vite ships, so a static import will not resolve under Vitest.
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * The v20 migration moves `skim_text` off `request` into `request_skim`.
 *
 * The chain from an empty file is exercised by every other test that calls
 * `openDb`; what none of them can see is the **backfill**, which only has rows to
 * carry on a database that already lived at v19. So this builds that database by
 * hand — `user_version = 19` and a `request` table still carrying the column, the
 * one shape v20's statements read — and asserts the three halves of the move:
 * the derivatives land in the side table, null derivatives settle as a flag with
 * no row, and the column itself is gone from `request`.
 */

const DERIVED = '2026-07-15T14-00-00-000_anthropic';
const DERIVED_NULL = '2026-07-15T15-00-00-000_anthropic';
const UNDERIVED = '2026-07-15T16-00-00-000_anthropic';

describe('migrating skim_text into the side table', () => {
  let logDir: string;

  beforeAll(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'skim-migrate-'));

    // A v19 database, reduced to what the v20 statements touch: the `request`
    // table with the column still on it, and the version stamp `migrate` reads.
    const db = new sqlite.DatabaseSync(resolveDbPath(logDir));
    db.exec(`
      CREATE TABLE request (
        id           TEXT PRIMARY KEY,
        skim_text    TEXT,
        body_derived INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insert = db.prepare('INSERT INTO request (id, skim_text, body_derived) VALUES (?, ?, ?)');
    insert.run(DERIVED, 'ask about the window read', 1);
    insert.run(DERIVED_NULL, null, 1);
    insert.run(UNDERIVED, null, 0);
    db.exec('PRAGMA user_version = 19');
    db.close();
  });

  afterAll(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it('backfills the derivatives, drops the column, and stamps the version', () => {
    const db = openDb(logDir);
    try {
      // SAFETY: `PRAGMA user_version` answers one row whose one column is named
      // `user_version`.
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);

      // The non-null derivative crossed over; the null one settled as the flag
      // alone, so the two v13 states stay distinguishable after the move.
      // SAFETY: the SELECT names exactly request_id and skim_text.
      const rows = db.prepare('SELECT request_id, skim_text FROM request_skim ORDER BY request_id').all() as Array<{
        request_id: string;
        skim_text: string;
      }>;
      expect(rows).toEqual([{ request_id: DERIVED, skim_text: 'ask about the window read' }]);

      // The column is gone from the hot table.
      // SAFETY: `PRAGMA table_info` rows always carry a `name` column.
      const columns = (db.prepare('PRAGMA table_info(request)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).not.toContain('skim_text');
      expect(columns).toContain('body_derived');
    } finally {
      db.close();
    }
  });
});
