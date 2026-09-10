import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { UsageDatabase } from '../src/database.ts';
import { RECORD_ADAPTER_VERSION, RECORD_HARNESS, RECORD_PROVIDER } from '../src/record-stamp.ts';
import { sidecar, temporaryDirectory } from './helpers.ts';

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire('node:sqlite') as typeof import('node:sqlite');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function temporaryPath(): Promise<string> {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  return join(temporary.path, 'usage.db');
}

/** A store at version 3 — the shape this build has to climb out of. */
function seedVersion3(path: string, recordIds: readonly string[]): void {
  const database = new DatabaseSync(path);
  database.exec(readFileSync(new URL('../migrations/003-car-reprice.sql', import.meta.url), 'utf8'));
  for (const recordId of recordIds) {
    database
      .prepare(
        `INSERT INTO usage_records (
           record_id, filename, event_timestamp, day_key, model, endpoint, response_status, request_id,
           input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
           cost_amount_usd, cost_catalogue_version, cost_unavailable_reason, sidecar_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recordId,
        `${recordId}.audit.json`,
        '2026-08-19T16:00:00.000Z',
        '2026-08-19',
        'gpt-5',
        '/v1/responses',
        200,
        `request-${recordId}`,
        10,
        0,
        4,
        0,
        14,
        '0.000053',
        'test',
        null,
        JSON.stringify(sidecar(recordId)),
      );
  }
  database.close();
}

describe('forward-only migration 3 → 4', () => {
  test('migrates a version 3 store to 4 with every row preserved', async () => {
    const path = await temporaryPath();
    seedVersion3(path, ['a', 'b', 'c']);

    const database = new UsageDatabase(path);
    expect(database.schemaVersion).toBe(4);
    expect(database.diagnostics().recordCount).toBe(3);
    database.close();

    const inspector = new DatabaseSync(path);
    const rows = inspector
      .prepare('SELECT record_id, model, provider, harness, adapter_version FROM usage_records ORDER BY record_id')
      .all() as unknown as Array<{
      record_id: string;
      model: string;
      provider: string;
      harness: string;
      adapter_version: number;
    }>;
    inspector.close();

    expect(rows.map((row) => row.record_id)).toEqual(['a', 'b', 'c']);
    // The backfill is a claim about history, not a placeholder: every row this
    // store could already hold was captured by codex-proxy off the OpenAI wire.
    for (const row of rows) {
      expect(row.provider).toBe(RECORD_PROVIDER);
      expect(row.harness).toBe(RECORD_HARNESS);
      expect(row.adapter_version).toBe(RECORD_ADAPTER_VERSION);
      expect(row.model).toBe('gpt-5');
    }
  });

  test('creates a fresh store directly at the current version', async () => {
    const path = await temporaryPath();
    const database = new UsageDatabase(path);
    expect(database.schemaVersion).toBe(4);
    database.close();
  });

  test('is idempotent — reopening an already-migrated store changes nothing', async () => {
    const path = await temporaryPath();
    seedVersion3(path, ['a']);
    const first = new UsageDatabase(path);
    first.close();

    const second = new UsageDatabase(path);
    expect(second.schemaVersion).toBe(4);
    expect(second.diagnostics().recordCount).toBe(1);
    second.close();
  });

  test('stamps provider, harness and adapter version on a freshly ingested record', async () => {
    const path = await temporaryPath();
    const database = new UsageDatabase(path);
    database.ingest('fresh.audit.json', sidecar('fresh'), new Date());
    database.close();

    const inspector = new DatabaseSync(path);
    const row = inspector
      .prepare('SELECT provider, harness, adapter_version FROM usage_records WHERE record_id = ?')
      .get('fresh') as unknown as { provider: string; harness: string; adapter_version: number };
    inspector.close();

    expect(row).toEqual({
      provider: RECORD_PROVIDER,
      harness: RECORD_HARNESS,
      adapter_version: RECORD_ADAPTER_VERSION,
    });
  });
});

describe('a version the ladder cannot reach refuses loudly', () => {
  test('refuses a version newer than this build', async () => {
    const path = await temporaryPath();
    seedVersion3(path, ['a']);
    const stamper = new DatabaseSync(path);
    stamper.exec('PRAGMA user_version = 99');
    stamper.close();

    expect(() => new UsageDatabase(path)).toThrow(/newer than this build/);
  });

  test('refuses a version below the oldest migration this build carries', async () => {
    const path = await temporaryPath();
    seedVersion3(path, ['a']);
    const stamper = new DatabaseSync(path);
    stamper.exec('PRAGMA user_version = 2');
    stamper.close();

    expect(() => new UsageDatabase(path)).toThrow(/predates the oldest migration/);
  });

  test('refuses a store carrying tables but no version stamp', async () => {
    const path = await temporaryPath();
    const unstamped = new DatabaseSync(path);
    unstamped.exec('CREATE TABLE something_else (id TEXT PRIMARY KEY)');
    unstamped.exec('PRAGMA user_version = 0');
    unstamped.close();

    expect(() => new UsageDatabase(path)).toThrow(/no schema version/);
  });

  test('a refusal leaves the database file byte-identical', async () => {
    const path = await temporaryPath();
    seedVersion3(path, ['a', 'b']);
    const stamper = new DatabaseSync(path);
    stamper.exec('PRAGMA user_version = 2');
    stamper.close();

    const before = readFileSync(path);
    const sizeBefore = statSync(path).size;

    expect(() => new UsageDatabase(path)).toThrow();

    expect(statSync(path).size).toBe(sizeBefore);
    expect(readFileSync(path).equals(before)).toBe(true);
    // Not even the journal sidecars: a refused store is left as it was found,
    // so there is nothing for the operator to clean up before restoring it.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });
});

// The guard against this defect returning. Until provider-seam ticket 04 the
// constructor answered a version mismatch by `rmSync`-ing the database, its
// `-wal` and its `-shm`, which ADR 0047 forbids and which would have destroyed
// the corpus on the first open after the version bump. A behavioural test can
// only prove the paths it thinks to walk, so this reads the source as well.
describe('no code path deletes the store', () => {
  const sourceDirectory = new URL('../src/', import.meta.url);

  test('no server source file calls a filesystem removal', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(sourceDirectory).filter((entry) => entry.endsWith('.ts'))) {
      const source = readFileSync(new URL(name, sourceDirectory), 'utf8');
      // `rm`/`unlink` in any form, plus `truncate`, which empties in place.
      const match = source.match(/\b(rmSync|rmdirSync|unlinkSync|truncateSync|rm|rmdir|unlink|truncate)\s*\(/);
      if (match) offenders.push(`${name}: ${match[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  test('no server source file imports a removal from node:fs', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(sourceDirectory).filter((entry) => entry.endsWith('.ts'))) {
      const source = readFileSync(new URL(name, sourceDirectory), 'utf8');
      for (const importMatch of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g)) {
        const imported = (importMatch[1] ?? '').split(',').map((entry) => entry.trim());
        const removals = imported.filter((entry) =>
          /^(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|truncate)$/.test(entry),
        );
        if (removals.length > 0) offenders.push(`${name}: ${removals.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the database never rebuilds itself by reapplying the whole baseline over a live store', async () => {
    // A rebuild would show up as row loss rather than as an exception, so this
    // asserts the rows rather than the mechanism.
    const path = await temporaryPath();
    seedVersion3(path, ['a', 'b']);
    const database = new UsageDatabase(path);
    expect(database.diagnostics().recordCount).toBe(2);
    database.close();
  });
});
