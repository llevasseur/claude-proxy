import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { auditConsistency, isConsistent } from '../src/consistency.ts';
import { UsageDatabase } from '../src/database.ts';
import { SidecarIngestor } from '../src/ingest.ts';
import { sidecar, temporaryDirectory, writeSidecar } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function setup(): Promise<{
  directory: string;
  databasePath: string;
  database: UsageDatabase;
}> {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  const databasePath = join(temporary.path, 'usage.db');
  return { directory: temporary.path, databasePath, database: new UsageDatabase(databasePath) };
}

describe('sidecar ingestion', () => {
  test('starts empty and backfills out-of-order final files exactly once', async () => {
    const { directory, database } = await setup();
    const now = new Date('2026-08-19T18:00:00.000Z');
    await writeSidecar(directory, 'z.audit.json', sidecar('later', '2026-08-19T17:00:00.000Z'));
    await writeSidecar(directory, 'a.audit.json', sidecar('earlier', '2026-08-19T15:00:00.000Z'));
    await writeFile(join(directory, '.partial.audit.json.uuid.tmp'), '{');
    await writeFile(join(directory, 'ignored.json'), '{}');
    const ingestor = new SidecarIngestor(directory, database, () => now);

    expect(await ingestor.reconcile()).toMatchObject({ changed: true, accepted: 2, rejected: 0 });
    const first = JSON.stringify(database.summary(now, 'America/New_York'));
    expect(database.diagnostics()).toMatchObject({ recordCount: 2, rejectedSidecars: 0 });

    expect(await ingestor.reconcile()).toMatchObject({ changed: false, accepted: 2, rejected: 0 });
    expect(JSON.stringify(database.summary(now, 'America/New_York'))).toBe(first);
    database.close();
  });

  test('restart, duplicate delivery, and transaction rollback do not double count', async () => {
    const { databasePath, database } = await setup();
    const now = new Date('2026-08-19T18:00:00.000Z');
    const record = sidecar('stable');
    expect(() =>
      database.ingest('stable.audit.json', record, now, {
        beforeWatermark: () => {
          throw new Error('simulated interruption');
        },
      }),
    ).toThrow('simulated interruption');
    expect(database.diagnostics().recordCount).toBe(0);
    expect(database.ingest('stable.audit.json', record, now)).toBe(true);
    expect(database.ingest('stable.audit.json', record, now)).toBe(false);
    expect(database.ingest('duplicate.audit.json', record, now)).toBe(false);
    database.close();

    const restarted = new UsageDatabase(databasePath);
    expect(restarted.diagnostics().recordCount).toBe(1);
    expect(restarted.summary(now, 'America/New_York').requestCount).toBe(1);
    restarted.close();
  });

  test('quarantines malformed and unsupported sidecars without blocking valid files', async () => {
    const { directory, database } = await setup();
    await writeFile(join(directory, 'broken.audit.json'), '{');
    await writeSidecar(directory, 'future.audit.json', { ...sidecar('future'), schemaVersion: 2 });
    await writeSidecar(directory, 'valid.audit.json', sidecar('valid'));
    const ingestor = new SidecarIngestor(directory, database, () => new Date('2026-08-19T18:00:00.000Z'));

    expect(await ingestor.reconcile()).toMatchObject({ changed: true, accepted: 1, rejected: 2 });
    expect(database.diagnostics()).toMatchObject({ recordCount: 1, rejectedSidecars: 2 });
    database.close();
  });

  test('waits for asynchronous reconciliation work before closing', async () => {
    const { directory, database } = await setup();
    let releaseCallback: () => void = () => {};
    let signalCallbackStarted: () => void = () => {};
    const callbackStarted = new Promise<void>((resolve) => {
      signalCallbackStarted = resolve;
    });
    const callbackReleased = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const ingestor = new SidecarIngestor(directory, database, undefined, async () => {
      signalCallbackStarted();
      await callbackReleased;
    });

    const reconciling = ingestor.reconcile();
    await callbackStarted;
    let closed = false;
    const closing = ingestor.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseCallback();
    await Promise.all([reconciling, closing]);
    database.close();
  });

  test('deleting SQLite and rebuilding from final sidecars reproduces summary JSON', async () => {
    const { directory, databasePath, database } = await setup();
    const now = new Date('2026-08-19T18:00:00.000Z');
    await writeSidecar(directory, 'one.audit.json', sidecar('one'));
    await writeSidecar(directory, 'two.audit.json', sidecar('two', '2026-08-19T17:00:00.000Z'));
    await new SidecarIngestor(directory, database, () => now).reconcile();
    const before = JSON.stringify(database.summary(now, 'America/New_York'));
    database.close();

    await rm(databasePath, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    const rebuilt = new UsageDatabase(databasePath);
    await new SidecarIngestor(directory, rebuilt, () => now).reconcile();
    expect(JSON.stringify(rebuilt.summary(now, 'America/New_York'))).toBe(before);

    // The rebuild output is consistent with its source on every axis.
    const report = await auditConsistency(rebuilt, directory);
    expect(report).toMatchObject({
      sidecarFiles: 2,
      recordRows: 2,
      watermarkRows: 2,
      missingRecords: [],
      missingWatermarks: [],
      orphanWatermarks: [],
    });
    expect(isConsistent(report)).toBe(true);
    rebuilt.close();
  });

  test('consistency audit detects records, watermarks, and orphans drifting apart', async () => {
    const { directory, database } = await setup();
    const now = new Date('2026-08-19T18:00:00.000Z');
    await writeSidecar(directory, 'one.audit.json', sidecar('one'));
    await writeSidecar(directory, 'two.audit.json', sidecar('two', '2026-08-19T17:00:00.000Z'));
    await new SidecarIngestor(directory, database, () => now).reconcile();

    // A source file deleted behind the store's back becomes an orphan watermark.
    await rm(join(directory, 'two.audit.json'), { force: true });
    // A new source file not yet ingested shows as missing record + watermark.
    await writeSidecar(directory, 'three.audit.json', sidecar('three', '2026-08-19T16:00:00.000Z'));

    const report = await auditConsistency(database, directory);
    expect(report.sidecarFiles).toBe(2);
    expect(report.watermarkRows).toBe(2);
    expect(report.missingRecords).toEqual(['three.audit.json']);
    expect(report.missingWatermarks).toEqual(['three.audit.json']);
    expect(report.orphanWatermarks).toEqual(['two.audit.json']);
    expect(isConsistent(report)).toBe(false);
    database.close();
  });
});
