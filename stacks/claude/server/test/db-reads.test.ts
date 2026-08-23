import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dbReadsEnabled, readSource, shadowSource, startSubstrate, stopSubstrate } from '../src/db/runtime.js';

/**
 * Which backing answers a read, and how to take it back. The default is the
 * substrate, and the reversal has to stay one flag and nothing else.
 */

afterEach(() => {
  stopSubstrate();
  delete process.env.DB_READS;
});

describe('dbReadsEnabled', () => {
  it('is on unless it is explicitly turned off', () => {
    expect(dbReadsEnabled({})).toBe(true);
    expect(dbReadsEnabled({ DB_READS: '1' })).toBe(true);
    expect(dbReadsEnabled({ DB_READS: '0' })).toBe(false);
    expect(dbReadsEnabled({ DB_READS: 'false' })).toBe(false);
  });
});

describe('readSource', () => {
  it('reads the files when no substrate ever opened, with no second opinion to shadow against', () => {
    expect(readSource().kind).toBe('files');
    expect(shadowSource()).toBeNull();
  });

  it('serves from the substrate once it is open, and the flag puts it back', async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), 'db-reads-'));
    try {
      expect(startSubstrate(logDir)).not.toBeNull();
      expect(readSource().kind).toBe('db');
      // The shadow is always the side that did *not* serve.
      expect(shadowSource()?.kind).toBe('files');

      process.env.DB_READS = '0';
      expect(readSource().kind).toBe('files');
      expect(shadowSource()?.kind).toBe('db');
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
