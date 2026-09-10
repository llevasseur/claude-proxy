import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrateNetDatabase, openNetDatabase, resolveNetDatabasePath, SCHEMA_VERSION } from '../src/db.ts';

const TABLES = ['sample', 'discontinuity', 'usage_day', 'config'] as const;

function tableNames(db: DatabaseSync): string[] {
  // SAFETY: the SELECT names `name`, a column sqlite_master always carries.
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function userVersion(db: DatabaseSync): number {
  // SAFETY: `PRAGMA user_version` always answers exactly one row carrying that
  // one integer column.
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('openNetDatabase', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'net-server-db-'));
  });

  it('creates migration 001 tables in a fresh database at user_version 1', () => {
    const db = openNetDatabase(':memory:');
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(tableNames(db)).toEqual([...TABLES].sort());
  });

  it('creates the database directory on open', () => {
    const path = join(directory, 'nested', 'data', 'net.sqlite');
    const db = openNetDatabase(path);
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  it('reopens an existing database without re-running migrations and keeps its rows', () => {
    const path = join(directory, 'net.sqlite');
    const first = openNetDatabase(path);
    first.exec("INSERT INTO config (key, value) VALUES ('limitBytes', '1073741824')");
    first.close();

    const second = openNetDatabase(path);
    expect(userVersion(second)).toBe(1);
    // SAFETY: the row was inserted above, and `value` is a NOT NULL TEXT column,
    // so the SELECT answers exactly one row carrying it.
    const row = second.prepare("SELECT value FROM config WHERE key = 'limitBytes'").get() as {
      value: string;
    };
    expect(row.value).toBe('1073741824');
    second.close();
  });

  it('refuses a database whose schema version is newer than supported instead of deleting it (ADR 0047)', () => {
    const path = join(directory, 'future.sqlite');
    const future = new DatabaseSync(path);
    future.exec('PRAGMA user_version = 99');
    future.close();

    expect(() => openNetDatabase(path)).toThrow(/newer than supported/);
    // The refused database is still on disk, untouched.
    expect(userVersion(new DatabaseSync(path))).toBe(99);
  });
});

describe('migrateNetDatabase', () => {
  it('is a no-op at the current version', () => {
    const db = openNetDatabase(':memory:');
    expect(migrateNetDatabase(db)).toBe(SCHEMA_VERSION);
    expect(userVersion(db)).toBe(1);
  });
});

describe('sample table shape (decision internet-spend 001)', () => {
  it('stores raw cumulative counters per (name, pid, interface) with an explicit interface column', () => {
    const db = openNetDatabase(':memory:');
    db.prepare(
      'INSERT INTO sample (timestamp, boot_epoch, name, pid, interface, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1_790_000_000_000, 42, 'Claude Helper (Renderer)', 901, 'en0', 1_000_000, 500_000);
    // SAFETY: the INSERT above wrote the one sample row, and the SELECT names
    // exactly the seven NOT NULL columns migration 001 declares.
    const row = db
      .prepare('SELECT timestamp, boot_epoch, name, pid, interface, bytes_in, bytes_out FROM sample')
      .get() as {
      timestamp: number;
      boot_epoch: number;
      name: string;
      pid: number;
      interface: string;
      bytes_in: number;
      bytes_out: number;
    };
    expect(row).toEqual({
      timestamp: 1_790_000_000_000,
      boot_epoch: 42,
      name: 'Claude Helper (Renderer)',
      pid: 901,
      interface: 'en0',
      bytes_in: 1_000_000,
      bytes_out: 500_000,
    });
  });

  it('rejects a discontinuity kind outside the checked set', () => {
    const db = openNetDatabase(':memory:');
    expect(() => db.prepare('INSERT INTO discontinuity (timestamp, kind) VALUES (?, ?)').run(1, 'meteor')).toThrow();
    db.prepare('INSERT INTO discontinuity (timestamp, kind) VALUES (?, ?)').run(1, 'boot');
    db.prepare('INSERT INTO discontinuity (timestamp, kind) VALUES (?, ?)').run(2, 'decrease');
    // SAFETY: `SELECT COUNT(*) AS count` always answers exactly one row holding
    // that one integer column.
    const count = db.prepare('SELECT COUNT(*) AS count FROM discontinuity').get() as { count: number };
    expect(count.count).toBe(2);
  });
});

describe('resolveNetDatabasePath', () => {
  it('prefers NET_DB_PATH when set', () => {
    expect(resolveNetDatabasePath({ NET_DB_PATH: '/tmp/explicit/net.sqlite' })).toBe('/tmp/explicit/net.sqlite');
  });

  it('anchors the default at the net stack data root per ADR 0054', () => {
    const resolved = resolveNetDatabasePath({});
    const stackDataRoot = 'stacks/net/data/net.sqlite';
    expect(resolved.endsWith(stackDataRoot)).toBe(true);
    expect(resolved.startsWith('/')).toBe(true);
  });
});
