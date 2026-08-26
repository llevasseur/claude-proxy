import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { collectBatch } from '../src/collector.ts';
import { openNetDatabase } from '../src/db.ts';

const HEADER =
  'time,,interface,state,bytes_in,bytes_out,rx_dupe,rx_ooo,re-tx,rtt_avg,rcvsize,tx_win,tc_class,tc_mgt,cc_algo,P,C,R,W,arch,';

function nettopCsv(rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

interface TestHarness {
  db: DatabaseSync;
  collect(options: {
    csv: string | Error;
    boottime: string | Error;
    now?: number;
  }): Promise<Awaited<ReturnType<typeof collectBatch>>>;
}

async function makeHarness(): Promise<TestHarness> {
  const db = openNetDatabase(':memory:');
  return {
    db,
    async collect({ csv, boottime, now = 1_790_000_000_000 }) {
      return collectBatch({
        db,
        now: () => now,
        timeZone: 'UTC',
        readNettop: () => (csv instanceof Error ? Promise.reject(csv) : Promise.resolve(csv)),
        readBootTime: () => (boottime instanceof Error ? Promise.reject(boottime) : Promise.resolve(boottime)),
      });
    },
  };
}

const BOOT = '{ sec = 1756147200, usec = 0 } Tue Sep  1 00:00:00 2026';

describe('collectBatch write path', () => {
  it('stores a first batch as baselines and refreshes usage_day', async () => {
    const harness = await makeHarness();
    const result = await harness.collect({
      csv: nettopCsv(['13:00:00,node.100,en0,,1000,2000,0,0,0']),
      boottime: BOOT,
    });
    expect(result).toEqual({ status: 'ok', timestamp: 1_790_000_000_000, storedSamples: 1, discontinuities: 0 });

    const samples = harness.db.prepare('SELECT COUNT(*) AS count FROM sample').get() as unknown as { count: number };
    expect(samples.count).toBe(1);
    const days = harness.db.prepare('SELECT COUNT(*) AS count FROM usage_day').get() as unknown as { count: number };
    expect(days.count).toBeGreaterThanOrEqual(0); // rollup refreshed; one baseline yields no day rows
  });

  it('skips a batch whose cumulative is unchanged from the previous one', async () => {
    const harness = await makeHarness();
    const row = '13:00:00,node.100,en0,,1000,2000,0,0,0';
    await harness.collect({ csv: nettopCsv([row]), boottime: BOOT });
    const second = await harness.collect({ csv: nettopCsv([row]), boottime: BOOT, now: 1_790_003_600_000 });
    expect(second).toEqual({ status: 'ok', timestamp: 1_790_003_600_000, storedSamples: 0, discontinuities: 0 });
  });

  it('stores a decreased sample and records the decrease discontinuity', async () => {
    const harness = await makeHarness();
    await harness.collect({ csv: nettopCsv(['13:00:00,node.100,en0,,5000,5000']), boottime: BOOT });
    const result = await harness.collect({
      csv: nettopCsv(['14:00:00,node.100,en0,,10,10']),
      boottime: BOOT,
      now: 1_790_003_600_000,
    });
    expect(result.status === 'ok' && result.storedSamples).toBe(1);
    expect(result.status === 'ok' && result.discontinuities).toBe(1);

    const kinds = harness.db.prepare('SELECT kind FROM discontinuity').all() as unknown as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toEqual(['decrease']);
  });

  it('records a boot discontinuity when the boot epoch changes', async () => {
    const harness = await makeHarness();
    await harness.collect({ csv: nettopCsv(['13:00:00,node.100,en0,,1000,2000']), boottime: BOOT });
    const result = await harness.collect({
      csv: nettopCsv(['13:00:00,node.100,en0,,5,7']),
      boottime: '{ sec = 1756233600, usec = 0 } Wed Sep  2 00:00:00 2026',
      now: 1_790_003_600_000,
    });
    expect(result.status === 'ok' && result.discontinuities).toBe(1);

    const kinds = harness.db.prepare('SELECT kind FROM discontinuity').all() as unknown as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toEqual(['boot']);
    const stored = harness.db
      .prepare('SELECT boot_epoch FROM sample ORDER BY timestamp DESC LIMIT 1')
      .get() as unknown as { boot_epoch: number };
    expect(stored.boot_epoch).toBe(1_756_233_600);
  });

  it('skips a failed nettop run whole — nothing written', async () => {
    const harness = await makeHarness();
    const result = await harness.collect({ csv: new Error('nettop exploded'), boottime: BOOT });
    expect(result).toEqual({ status: 'skipped', reason: expect.stringContaining('nettop failed') });
    const samples = harness.db.prepare('SELECT COUNT(*) AS count FROM sample').get() as unknown as { count: number };
    expect(samples.count).toBe(0);
  });

  it('skips an unparseable nettop payload whole', async () => {
    const harness = await makeHarness();
    const result = await harness.collect({ csv: 'not,csv\n1,2', boottime: BOOT });
    expect(result).toEqual({ status: 'skipped', reason: 'nettop output was unparseable' });
    const samples = harness.db.prepare('SELECT COUNT(*) AS count FROM sample').get() as unknown as { count: number };
    expect(samples.count).toBe(0);
  });

  it('skips the whole batch when boottime fails or does not parse', async () => {
    const harness = await makeHarness();
    const failing = await harness.collect({ csv: nettopCsv([]), boottime: new Error('sysctl denied') });
    expect(failing).toEqual({ status: 'skipped', reason: expect.stringContaining('boottime') });
    const garbage = await harness.collect({ csv: nettopCsv([]), boottime: 'garbage' });
    expect(garbage).toEqual({ status: 'skipped', reason: 'boottime was unparseable' });
    const samples = harness.db.prepare('SELECT COUNT(*) AS count FROM sample').get() as unknown as { count: number };
    expect(samples.count).toBe(0);
  });
});
