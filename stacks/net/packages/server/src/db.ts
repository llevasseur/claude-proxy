import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ADR 0047: the database migrates forward through a versioned ladder keyed on
// PRAGMA user_version. A database at an older version is migrated up; a
// mismatch is never resolved by deletion.

export const SCHEMA_VERSION = 1;

const MIGRATION_001 = `
CREATE TABLE sample (
  timestamp INTEGER NOT NULL,
  boot_epoch INTEGER NOT NULL,
  name TEXT NOT NULL,
  pid INTEGER NOT NULL,
  interface TEXT NOT NULL,
  bytes_in INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL
);

CREATE INDEX sample_series_idx ON sample (name, pid, interface, timestamp);

CREATE TABLE discontinuity (
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('boot', 'decrease'))
);

-- Rebuildable rollup (decision internet-spend 003): inherited bucketing,
-- rebuilt from raw rows, never trusted at read time.
CREATE TABLE usage_day (
  date TEXT PRIMARY KEY,
  bytes_in INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  partial INTEGER NOT NULL
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** The migration ladder, keyed by the schema version each step arrives at. */
interface MigrationLadder {
  readonly [version: number]: string;
}

const MIGRATIONS: MigrationLadder = {
  1: MIGRATION_001,
};

// An object type rather than an interface, so it stays comparable to the
// `Record<string, …>` row shape node:sqlite returns.
type VersionRow = {
  readonly user_version: number;
};

function userVersion(db: DatabaseSync): number {
  // SAFETY: `PRAGMA user_version` always answers exactly one row carrying that
  // one integer column, so the row is present and shaped as declared.
  return (db.prepare('PRAGMA user_version').get() as VersionRow).user_version;
}

export function migrateNetDatabase(db: DatabaseSync): number {
  const version = userVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(`net database schema version ${version} is newer than supported ${SCHEMA_VERSION}`);
  }
  for (let target = version + 1; target <= SCHEMA_VERSION; target++) {
    const migration = MIGRATIONS[target];
    if (!migration) {
      throw new Error(`missing migration for schema version ${target}`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration);
      db.exec(`PRAGMA user_version = ${target}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return userVersion(db);
}

/**
 * `NET_DB_PATH` wins when set; otherwise the database anchors at the net
 * stack's own data root (`stacks/net/data/net.sqlite`). Per ADR 0054 the
 * `import.meta.dirname` anchor means "my stack's root" — three levels up from
 * this file — never the repository root.
 */
export function resolveNetDatabasePath(
  env: { readonly NET_DB_PATH?: string | undefined } = { NET_DB_PATH: process.env.NET_DB_PATH },
): string {
  if (env.NET_DB_PATH) return env.NET_DB_PATH;
  return join(import.meta.dirname, '..', '..', '..', 'data', 'net.sqlite');
}
export function openNetDatabase(path: string = resolveNetDatabasePath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  migrateNetDatabase(db);
  return db;
}
