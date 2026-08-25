import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../proxy/json.ts';
import { buildContextThread } from '../src/api.js';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource, readThreadWindow, type SidecarSource } from '../src/db/source.js';

/**
 * The thread page asks for one transcript, and `request.thread_id` is indexed —
 * so the substrate answers it as a seek instead of materializing every sidecar
 * in the span to keep a handful of them.
 *
 * Two things have to hold at once, and both are pinned here. The answer must not
 * change: the file backing still scans and filters, and the two backings agree
 * request for request, including the window's day rules. And the substrate must
 * not read the window at all, which is counted rather than timed.
 */

/** 22:00 EDT on the newest reporting day, so that day is open and still live. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';
const RECENT_DAY = '2026-08-01';
const OLD_DAY = '2026-07-30';

const MINE = 'ffeeddccbbaa9988';
const OTHER = '1122334455667788';

/** 11:00 EDT — the reporting day matches the UTC day the file is named for. */
function morning(day: string, hour = 15): string {
  return `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

/** 21:00 EDT on `day`, which is the *next* UTC day, so it stays in the live root. */
function evening(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T01:00:00.000Z`;
}

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

async function writeSidecar(dir: string, iso: string, realInput: number, threadId: string | null): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body: JsonObject = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
  };
  if (threadId !== null) body.session = { sessionId: `session-of-${threadId}`, threadId };
  await writeFile(path.join(dir, `${stemFor(iso)}.audit.json`), JSON.stringify(body), 'utf8');
}

let logDir: string;
let db: DatabaseSync;

/**
 * One thread spread across an archived day, a day older than any bounded window
 * reaches, and the live root — with a busier second thread and one session-less
 * sidecar around it, so a read that answers the window rather than the thread
 * comes back visibly wrong.
 */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-thread-index-'));
  await writeSidecar(path.join(logDir, 'archive', OLD_DAY), morning(OLD_DAY), 11_000, MINE);
  await writeSidecar(path.join(logDir, 'archive', RECENT_DAY), morning(RECENT_DAY), 22_000, MINE);
  await writeSidecar(path.join(logDir, 'archive', RECENT_DAY), morning(RECENT_DAY, 16), 33_000, OTHER);
  await writeSidecar(path.join(logDir, 'archive', TODAY), morning(TODAY), 44_000, OTHER);
  await writeSidecar(logDir, evening(TODAY), 55_000, MINE);
  await writeSidecar(logDir, evening(TODAY).replace('T01', 'T02'), 66_000, null);
  db = openDb(logDir);
  await ingest(db, logDir);
});

afterEach(() => {
  db?.close();
});

/** Wraps a backing so every window read it is asked for is counted. */
function counting(source: SidecarSource) {
  let reads = 0;
  const wrapped: SidecarSource = {
    ...source,
    readSidecars: (...args) => {
      reads += 1;
      return source.readSidecars(...args);
    },
    readArchivedDay: (...args) => {
      reads += 1;
      return source.readArchivedDay(...args);
    },
  };
  if (source.readAllDays) {
    wrapped.readAllDays = (...args: Parameters<NonNullable<SidecarSource['readAllDays']>>) => {
      reads += 1;
      return source.readAllDays!(...args);
    };
  }
  return { source: wrapped, windowReads: () => reads };
}

describe('the thread read', () => {
  it('answers one thread, not the window it sits in', async () => {
    const thread = await buildContextThread(logDir, MINE, 3, NOW, dbSource(db));

    expect(thread.entries.map((e) => e.timestamp)).toEqual([morning(RECENT_DAY), evening(TODAY)]);
    // The window holds five other requests; none of them is counted here.
    expect(thread.meta.files).toBe(2);
    expect(thread.meta.parseErrors).toBe(0);
  });

  it('keeps the day rules of the window — a request older than the span stays out', async () => {
    const narrow = await buildContextThread(logDir, MINE, 3, NOW, dbSource(db));
    const wide = await buildContextThread(logDir, MINE, 30, NOW, dbSource(db));

    expect(narrow.entries).toHaveLength(2);
    expect(wide.entries.map((e) => e.timestamp)).toEqual([morning(OLD_DAY), morning(RECENT_DAY), evening(TODAY)]);
  });

  it('answers a thread with nothing in the window as an empty list, not a 404', async () => {
    const empty = await buildContextThread(logDir, 'aaaabbbbccccdddd', 30, NOW, dbSource(db));

    expect(empty.threadId).toBe('aaaabbbbccccdddd');
    expect(empty.entries).toEqual([]);
    expect(empty.prompt).toBeNull();
    expect(empty.meta.files).toBe(0);
  });
});

describe('the two backings agree on one thread', () => {
  it('answers the same thread page through files and through the substrate', async () => {
    for (const days of [3, 30]) {
      const fromFiles = await buildContextThread(logDir, MINE, days, NOW, fileSource);
      const fromDb = await buildContextThread(logDir, MINE, days, NOW, dbSource(db));

      expect(fromDb).toEqual(fromFiles);
    }
  });

  it('agrees on a thread the corpus has never heard of', async () => {
    const fromFiles = await buildContextThread(logDir, 'aaaabbbbccccdddd', 30, NOW, fileSource);
    const fromDb = await buildContextThread(logDir, 'aaaabbbbccccdddd', 30, NOW, dbSource(db));

    expect(fromDb).toEqual(fromFiles);
  });

  it('agrees at the seam itself, sidecar for sidecar', async () => {
    const fromFiles = await readThreadWindow(logDir, MINE, { sinceDays: 30, includeFile: true }, NOW, fileSource);
    const fromDb = await readThreadWindow(logDir, MINE, { sinceDays: 30, includeFile: true }, NOW, dbSource(db));

    expect(fromDb.files).toBe(3);
    // SAFETY: both reads above pass `includeFile: true`, and `readThreadWindow` in
    // db/source.ts sets `sidecar.__file = entry.stem` on every entry whenever that
    // option is set — the field is always present on both sides here.
    expect(fromDb.sidecars.map((s) => (s as { __file: string }).__file)).toEqual(
      fromFiles.sidecars.map((s) => (s as { __file: string }).__file),
    );
  });
});

describe('how each backing gets there', () => {
  it('never reads the window on the substrate, however wide the span', async () => {
    const { source, windowReads } = counting(dbSource(db));

    const thread = await buildContextThread(logDir, MINE, 30, NOW, source);

    expect(thread.entries).toHaveLength(3);
    expect(windowReads()).toBe(0);
  });

  it('keeps the scan the file backing has today', async () => {
    const { source, windowReads } = counting(fileSource);

    const thread = await buildContextThread(logDir, MINE, 3, NOW, source);

    expect(thread.entries).toHaveLength(2);
    // The live root plus one call per day of the span — unchanged.
    expect(windowReads()).toBeGreaterThan(0);
  });
});
