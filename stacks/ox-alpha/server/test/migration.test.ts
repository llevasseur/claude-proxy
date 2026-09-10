import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SanitizedAuditSidecarV1 } from '@agent-proxy/ox-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OX_RECORD_STAMP, UsageDatabase } from '../src/database.ts';
import { sidecar, temporaryDirectory } from './helpers.ts';

/**
 * The version 1 schema, spelled out here rather than imported from the module under
 * test.
 *
 * That duplication is the point: a fixture built from the module's own `SCHEMA_V1`
 * would be rewritten by the same edit that broke the ladder, and the test would keep
 * passing. This is what a store actually on disk at version 1 looks like, frozen.
 */
const V1_SCHEMA = `
CREATE TABLE usage_records (
  record_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  event_timestamp TEXT NOT NULL,
  sidecar_json TEXT NOT NULL
);

CREATE INDEX usage_records_timestamp_idx
  ON usage_records (event_timestamp);

CREATE TABLE ingest_watermarks (
  filename TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE TABLE rejected_sidecars (
  filename TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  rejected_at TEXT NOT NULL
);

PRAGMA user_version = 1;
`;

interface StoredRow {
  readonly record_id: string;
  readonly sidecar_json: string;
  readonly provider: string | null;
  readonly harness: string | null;
  readonly model: string | null;
  readonly adapter_version: number | null;
}

/** Build a store on disk at version 1 and return each row's blob, byte for byte. */
function writeVersionOneStore(
  path: string,
  sidecars: readonly SanitizedAuditSidecarV1[],
  version = 1,
): readonly string[] {
  const database = new DatabaseSync(path);
  database.exec(V1_SCHEMA);
  const serialized = sidecars.map((value) => JSON.stringify(value));
  sidecars.forEach((value, index) => {
    database
      .prepare('INSERT INTO usage_records (record_id, filename, event_timestamp, sidecar_json) VALUES (?, ?, ?, ?)')
      .run(value.recordId, `${value.recordId}.audit.json`, value.timestamp, serialized[index] as string);
  });
  if (version !== 1) database.exec(`PRAGMA user_version = ${version}`);
  database.close();
  return serialized;
}

function readStoredRows(path: string): readonly StoredRow[] {
  const database = new DatabaseSync(path);
  const rows = database
    .prepare(
      'SELECT record_id, sidecar_json, provider, harness, model, adapter_version FROM usage_records ORDER BY record_id',
    )
    .all() as unknown as StoredRow[];
  database.close();
  return rows;
}

describe('ox usage store migration', () => {
  let directory = '';
  let cleanup: () => Promise<void> = async () => undefined;
  let path = '';

  beforeEach(async () => {
    const temporary = await temporaryDirectory();
    directory = temporary.path;
    cleanup = temporary.cleanup;
    path = join(directory, 'usage.db');
  });

  afterEach(async () => {
    await cleanup();
  });

  it('creates a fresh store at the current version', () => {
    const store = new UsageDatabase(path);
    expect(store.schemaVersion).toBe(2);
    store.close();
  });

  it('migrationPreservesRows: every row and its sidecar_json survive 1 to 2 byte-identical', () => {
    const sidecars = [
      sidecar('alpha', '2026-08-19T10:00:00.000Z', { model: 'gpt-5' }),
      sidecar('bravo', '2026-08-19T11:00:00.000Z', { model: 'gpt-5-mini' }),
      sidecar('charlie', '2026-08-19T12:00:00.000Z', { model: 'o4-mini', unavailable: true }),
    ];
    const before = writeVersionOneStore(path, sidecars);
    const inodeBefore = statSync(path).ino;

    const store = new UsageDatabase(path);
    expect(store.schemaVersion).toBe(2);
    store.close();

    const rows = readStoredRows(path);
    expect(rows).toHaveLength(3);
    // `before` is already in record_id order, which is the order rows come back in.
    expect(rows.map((row) => row.sidecar_json)).toEqual(before);
    // The store was migrated in place, never recreated underneath us.
    expect(statSync(path).ino).toBe(inodeBefore);
  });

  it('backfills the four provenance columns from the blob', () => {
    const sidecars = [
      sidecar('alpha', '2026-08-19T10:00:00.000Z', { model: 'gpt-5' }),
      sidecar('bravo', '2026-08-19T11:00:00.000Z', { model: 'gpt-5-mini' }),
    ];
    writeVersionOneStore(path, sidecars);

    const store = new UsageDatabase(path);
    store.close();

    const rows = readStoredRows(path);
    expect(rows.map((row) => row.model)).toEqual(['gpt-5', 'gpt-5-mini']);
    for (const row of rows) {
      expect(row.provider).toBe(OX_RECORD_STAMP.provider);
      expect(row.harness).toBe(OX_RECORD_STAMP.harness);
      expect(row.adapter_version).toBe(OX_RECORD_STAMP.adapterVersion);
    }
  });

  it('every backfilled model equals the model inside its own blob', () => {
    const sidecars = [
      sidecar('alpha', '2026-08-19T10:00:00.000Z', { model: 'gpt-5' }),
      sidecar('bravo', '2026-08-19T11:00:00.000Z', { model: 'a/model-with.punctuation' }),
    ];
    writeVersionOneStore(path, sidecars);

    const store = new UsageDatabase(path);
    store.close();

    for (const row of readStoredRows(path)) {
      const blob = JSON.parse(row.sidecar_json) as { model: string };
      expect(row.model).toBe(blob.model);
    }
  });

  it('stamps all four columns at ingest', () => {
    const store = new UsageDatabase(path);
    expect(store.ingest('delta.audit.json', sidecar('delta', '2026-08-19T13:00:00.000Z', { model: 'gpt-5' }), new Date())).toBe(
      true,
    );
    store.close();

    const rows = readStoredRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: OX_RECORD_STAMP.provider,
      harness: OX_RECORD_STAMP.harness,
      model: 'gpt-5',
      adapter_version: OX_RECORD_STAMP.adapterVersion,
    });
  });

  it('reads model from the column rather than from the blob', () => {
    // Deliberately disagreeing values, which ingest can never produce. If the read
    // path ever goes back to parsing the blob, this flips to 'from-the-blob'.
    const store = new UsageDatabase(path);
    store.close();
    const raw = new DatabaseSync(path);
    const payload = JSON.stringify(sidecar('echo', '2026-08-19T14:00:00.000Z', { model: 'from-the-blob' }));
    raw
      .prepare(
        `INSERT INTO usage_records
           (record_id, filename, event_timestamp, sidecar_json, provider, harness, model, adapter_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('echo', 'echo.audit.json', '2026-08-19T14:00:00.000Z', payload, 'ox-alpha', 'opencode', 'from-the-column', 1);
    raw.close();

    const reopened = new UsageDatabase(path);
    const page = reopened.history(
      {
        reportTimezone: 'America/New_York',
        startInclusive: null,
        endExclusive: new Date('2027-01-01T00:00:00.000Z'),
      },
      [],
      null,
      0,
    );
    reopened.close();

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.model).toBe('from-the-column');
  });

  it('refuses a version the ladder cannot reach, and leaves the store untouched', () => {
    const sidecars = [sidecar('alpha', '2026-08-19T10:00:00.000Z', { model: 'gpt-5' })];
    const before = writeVersionOneStore(path, sidecars, 9);
    const inodeBefore = statSync(path).ino;

    expect(() => new UsageDatabase(path)).toThrow(/unsupported database schema version 9/);

    // Refusal is not repair: nothing was deleted, rebuilt, downgraded, or migrated.
    // The store is read back with the version 1 column list on purpose — selecting
    // `provider` here would fail, and that it would fail is the assertion.
    expect(statSync(path).ino).toBe(inodeBefore);
    const raw = new DatabaseSync(path);
    const rows = raw
      .prepare('SELECT sidecar_json FROM usage_records ORDER BY record_id')
      .all() as unknown as Array<{ sidecar_json: string }>;
    const version = raw.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    const columns = raw.prepare('PRAGMA table_info(usage_records)').all() as unknown as Array<{ name: string }>;
    raw.close();

    expect(rows.map((row) => row.sidecar_json)).toEqual(before);
    expect(version.user_version).toBe(9);
    expect(columns.map((column) => column.name)).toEqual([
      'record_id',
      'filename',
      'event_timestamp',
      'sidecar_json',
    ]);
  });

  it('never deletes or recreates the database, its -wal or its -shm', () => {
    const source = readFileSync(new URL('../src/database.ts', import.meta.url), 'utf8');
    // A ladder that repairs a mismatch by removing the store violates ADR 0048. The
    // sibling codex store did exactly that; ox must never acquire the habit.
    expect(source).not.toMatch(/unlink|rmSync|rm\(|DROP TABLE|DROP INDEX|VACUUM INTO/);
    expect(source).not.toMatch(/-wal|-shm/);
  });
});
