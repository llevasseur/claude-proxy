import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingest } from '../src/db/ingest.js';
import { BACKUP_DIR, openDb, resolveDbPath, SCHEMA_VERSION } from '../src/db/open.js';

/**
 * Migration 23 — the record stamp, and the backup taken before the ladder runs.
 *
 * The cases here are the ones the ticket's own criteria name, and each is load
 * bearing for a different reason:
 *
 * - **Nothing is lost.** `docs/adrs/0047-sqlite-substrate-with-forward-only-migrations.md`
 *   forbids resolving a version mismatch by deletion and
 *   `docs/adrs/0048-deletion-policy-split-by-tier.md` forbids deleting the record
 *   tier at all, so the migration is checked column by column against a snapshot
 *   taken before it ran — not merely by counting rows.
 * - **The file is the same file.** The strongest available statement of "no code
 *   path deletes, recreates or truncates the database" is that its inode does not
 *   change across the migration, which a delete-and-rebuild cannot fake.
 * - **Unknown stays unknown.** `adapter_version` is null for every backfilled row
 *   on purpose: those records predate the adapter contract, so any number would
 *   claim a provenance they do not have.
 */

/** What a column of these tables can hold. Narrow on purpose — no blobs here. */
type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

const V1_SIDECAR_STEM = '2026-08-20T10-00-00-000_anthropic';
const V2_SIDECAR_STEM = '2026-08-20T11-00-00-000_anthropic';

/**
 * Every row a query answers, as plain columns.
 *
 * The two decoding assertions in this file are here and in `queryOne`, rather
 * than at each of the twenty-odd call sites that would otherwise need one.
 */
function queryAll(db: DatabaseSync, sql: string, ...params: string[]): SqlRow[] {
  // SAFETY: every column selected by this file's queries is declared TEXT or
  // INTEGER and none is a blob, so each value is a string, a number, or null.
  return db.prepare(sql).all(...params) as SqlRow[];
}

/** The first row a query answers, or undefined when it answers none. */
function queryOne(db: DatabaseSync, sql: string, ...params: string[]): SqlRow | undefined {
  // SAFETY: the same invariant as `queryAll` above.
  return db.prepare(sql).get(...params) as SqlRow | undefined;
}

function sidecarBody(iso: string, model: string) {
  return {
    timestamp: iso,
    model,
    endpoint: '/v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
    session: { sessionId: 's-1', app: 'claude-code', userAgent: 'claude-cli/2.0' },
    skim: { enabled: true, servedFromCache: false, savedInputTokens: 0, cacheKey: null },
  };
}

/** A sidecar triple: the audit row plus the body the skim is derived from. */
async function writeTriple(dir: string, stem: string, extra: Record<string, SqlValue> = {}): Promise<void> {
  const iso = '2026-08-20T10:00:00.000Z';
  await writeFile(
    path.join(dir, `${stem}.audit.json`),
    JSON.stringify({ ...sidecarBody(iso, 'claude-opus-5'), ...extra }),
    'utf8',
  );
  await writeFile(path.join(dir, `${stem}.md`), `# ${iso}\n`, 'utf8');
  await writeFile(
    path.join(dir, `${stem}.request.txt`),
    JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'the asked question' }] }] }),
    'utf8',
  );
}

/**
 * Put a fully-migrated database back to 22, which is what a database captured
 * before this ticket looks like. Dropping the three columns and lowering
 * `user_version` is the whole difference — no other slice touched `request`.
 */
function downgradeTo22(db: DatabaseSync): void {
  db.exec('ALTER TABLE request DROP COLUMN provider');
  db.exec('ALTER TABLE request DROP COLUMN harness');
  db.exec('ALTER TABLE request DROP COLUMN adapter_version');
  db.exec('PRAGMA user_version = 22');
}

function readVersion(db: DatabaseSync): number {
  return Number(queryOne(db, 'PRAGMA user_version')?.user_version ?? 0);
}

function allRequests(db: DatabaseSync): SqlRow[] {
  return queryAll(db, 'SELECT * FROM request ORDER BY id');
}

async function backupFiles(logDir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(logDir, BACKUP_DIR))).sort();
  } catch {
    return [];
  }
}

describe('migration 23 — the record stamp', () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'migration-23-'));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  /** Ingest two sidecars, then hand back a database sitting at 22. */
  async function seedAt22(): Promise<{ before: SqlRow[]; skims: SqlRow[] }> {
    await writeTriple(logDir, V1_SIDECAR_STEM);
    await writeTriple(logDir, V2_SIDECAR_STEM, {
      schemaVersion: 2,
      provider: 'anthropic',
      harness: 'claude-code',
      adapterVersion: 1,
    });

    const db = openDb(logDir);
    await ingest(db, logDir);
    const skims = queryAll(db, 'SELECT * FROM request_skim ORDER BY request_id');
    downgradeTo22(db);
    const before = allRequests(db);
    db.close();
    // Anything the seeding open wrote is not what the assertions are about.
    await rm(path.join(logDir, BACKUP_DIR), { recursive: true, force: true });
    return { before, skims };
  }

  it('migrates 22 to 23 preserving every row and every existing column value', async () => {
    const { before } = await seedAt22();
    expect(before.length).toBe(2);

    const migrated = openDb(logDir);
    expect(readVersion(migrated)).toBe(23);
    expect(readVersion(migrated)).toBe(SCHEMA_VERSION);

    const after = allRequests(migrated);
    expect(after.length).toBe(before.length);

    // Column by column, not row count: a migration that silently blanked a value
    // would still pass a count.
    for (const [index, priorRow] of before.entries()) {
      const migratedRow = after[index];
      expect(migratedRow).toBeDefined();
      for (const [column, value] of Object.entries(priorRow)) {
        expect(migratedRow?.[column], `column ${column}`).toStrictEqual(value);
      }
    }
    migrated.close();
  });

  it('backfills provider and harness, keeps model, and leaves adapter_version explicitly unknown', async () => {
    await seedAt22();

    const migrated = openDb(logDir);
    const rows = allRequests(migrated);
    expect(rows.length).toBe(2);

    for (const row of rows) {
      expect(row.provider).toBe('anthropic');
      expect(row.harness).toBe('claude-code');
      // The stamp's fourth field, a column since slice 1 rather than one this
      // migration adds.
      expect(row.model).toBe('claude-opus-5');
      // Captured before any versioned adapter existed, so any number here would
      // be a guess. Null is the explicit unknown the ticket asks for.
      expect(row.adapter_version).toBeNull();
    }
    migrated.close();
  });

  it('adds no cost or pricing_source column', async () => {
    const db = openDb(logDir);
    const columns = queryAll(db, 'SELECT name FROM pragma_table_info(?)', 'request').map((row) => row.name);
    expect(columns).not.toContain('cost');
    expect(columns).not.toContain('pricing_source');
    expect(columns).toContain('provider');
    expect(columns).toContain('harness');
    expect(columns).toContain('adapter_version');
    db.close();
  });

  it('is a no-op on a database already at 23, and takes no second backup', async () => {
    await seedAt22();

    const first = openDb(logDir);
    const afterFirst = allRequests(first);
    first.close();
    const backupsAfterFirst = await backupFiles(logDir);
    expect(backupsAfterFirst.length).toBe(1);

    const second = openDb(logDir);
    expect(readVersion(second)).toBe(23);
    expect(allRequests(second)).toStrictEqual(afterFirst);
    second.close();

    // The backup is taken on the one open that crosses into 23. A database
    // already there has nothing pending to protect.
    expect(await backupFiles(logDir)).toStrictEqual(backupsAfterFirst);
  });

  it('never deletes, recreates or truncates the database file or its sidecars', async () => {
    await seedAt22();
    const dbPath = resolveDbPath(logDir);
    const before = fs.statSync(dbPath);

    const migrated = openDb(logDir);
    expect(readVersion(migrated)).toBe(23);
    migrated.close();

    const after = fs.statSync(dbPath);
    // A delete-and-rebuild cannot preserve the inode, so this is the assertion
    // that actually distinguishes migrating from rebuilding.
    expect(after.ino).toBe(before.ino);
    expect(after.birthtimeMs).toBe(before.birthtimeMs);
    expect(after.size).toBeGreaterThanOrEqual(before.size);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('writes the pre-migration backup of request_skim and body_derived before the ladder runs', async () => {
    const { before, skims } = await seedAt22();
    expect(skims.length).toBeGreaterThan(0);

    const migrated = openDb(logDir);
    migrated.close();

    const files = await backupFiles(logDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^pre-migration-23-.*\.jsonl$/);

    const text = await readFile(path.join(logDir, BACKUP_DIR, String(files[0])), 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines.length).toBe(before.length);

    const parsed = lines.map((line) => {
      // SAFETY: each line was written by `backUpBeforeMigration23` from a row of
      // the same three declared columns this type names.
      return JSON.parse(line) as SqlRow;
    });
    for (const entry of parsed) {
      expect(entry.id).toEqual(expect.any(String));
      expect(entry.body_derived).toBe(1);
      expect(entry.skim_text).toEqual(expect.any(String));
    }
    // Every skim that existed before the migration is in the copy.
    const backedUp = new Set(parsed.map((entry) => entry.id));
    for (const skim of skims) {
      expect(backedUp.has(skim.request_id)).toBe(true);
    }
  });

  it('writes no backup for a database that has nothing to lose', async () => {
    const fresh = openDb(logDir);
    fresh.close();
    expect(await backupFiles(logDir)).toStrictEqual([]);
  });
});

describe('ingest fills the record stamp', () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'stamp-ingest-'));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it('takes the stamp a v2 sidecar states', async () => {
    await writeTriple(logDir, V2_SIDECAR_STEM, {
      schemaVersion: 2,
      provider: 'anthropic',
      harness: 'claude-code',
      adapterVersion: 1,
    });
    const db = openDb(logDir);
    await ingest(db, logDir);

    const row = queryOne(db, 'SELECT provider, harness, adapter_version FROM request');
    expect(row?.provider).toBe('anthropic');
    expect(row?.harness).toBe('claude-code');
    expect(row?.adapter_version).toBe(1);
    db.close();
  });

  it('resolves a v1 sidecar from the capturing adapter, with no adapter version to record', async () => {
    await writeTriple(logDir, V1_SIDECAR_STEM);
    const db = openDb(logDir);
    await ingest(db, logDir);

    const row = queryOne(db, 'SELECT provider, harness, adapter_version FROM request');
    expect(row?.provider).toBe('anthropic');
    expect(row?.harness).toBe('claude-code');
    expect(row?.adapter_version).toBeNull();
    db.close();
  });

  it('skips a sidecar naming an unregistered provider rather than reattributing it', async () => {
    await writeTriple(logDir, V2_SIDECAR_STEM, {
      schemaVersion: 2,
      provider: 'not-a-registered-provider',
      harness: 'claude-code',
      adapterVersion: 1,
    });
    const db = openDb(logDir);
    const stats = await ingest(db, logDir);

    expect(stats.skipped).toBe(1);
    expect(queryOne(db, 'SELECT COUNT(*) AS n FROM request')?.n).toBe(0);
    db.close();
  });
});
