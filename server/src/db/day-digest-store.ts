import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageDigest } from '@claude-proxy/core';
import { openDb, resolveDbPath, SCHEMA_VERSION } from './open.js';

/**
 * Level two of the closed-day digest cache: one row per closed day, so the work
 * a process did survives that process.
 *
 * `day-digest-memo.ts` is level one and keeps its own contract — the map is
 * consulted first and a row is promoted into it on a hit. This file only answers
 * "did some earlier process already compute this exact day?", which the in-process
 * memo cannot: a cold server pays the full corpus scan for the first read of
 * every window route, and that was the memo's own stated limit.
 *
 * A row is a **derived** value for a day that can no longer change, never a
 * source of truth. `logs/` still holds every sidecar, and
 * `rm logs/claude-proxy.db && pnpm --filter server ingest` still reconstructs
 * everything — a lost row costs one recomputation and nothing else. See
 * `docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md`.
 */

/**
 * Bump when `computeDigest` would answer differently for the same sidecars — a
 * new digest field, a changed formula, an edited pricing table. Nothing in the
 * key can notice that on its own, and a row that outlives such a change would
 * pin the old answer in place; the in-process memo never had to care because a
 * code change implies a restart. Stale revisions are pruned on open, so a bump
 * costs one recomputation per day.
 */
const DAY_DIGEST_REVISION = 1;

/**
 * The schema version rides along because an ingest-shape migration re-reads the
 * corpus (those steps clear `ingest_watermark`), which can change what a
 * DB-backed digest of an already-closed day contains.
 */
const REVISION = `${SCHEMA_VERSION}.${DAY_DIGEST_REVISION}`;

/**
 * Everything that makes two reads of "the same day" the same, flattened for the
 * row's primary key — `keyOf` in `day-digest-memo.ts`, component for component.
 * The backing is in it because the parity harness computes both ways and the two
 * must never share a row; the classifier hash-set *size* is, because that store
 * only grows and a digest taken before a new revision was recorded would
 * otherwise never be recomputed.
 */
export interface StoredDayDigestKey {
  /** `SidecarSource.kind` — `'files'` or `'db'`. */
  backing: string;
  logDir: string;
  /** The relocated archive root, or `''` for none. */
  archiveDir: string;
  date: string;
  classifierCount: number;
}

const SELECT = `
SELECT digest FROM day_digest
WHERE backing = ? AND log_dir = ? AND archive_dir = ? AND date = ?
  AND classifier_count = ? AND revision = ?
`;

/**
 * `DO NOTHING` rather than an update: the key pins the day, the backing and every
 * revision that could change the answer, so a conflicting row already holds this
 * digest.
 */
const INSERT = `
INSERT INTO day_digest (backing, log_dir, archive_dir, date, classifier_count, revision, digest, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING
`;

/** One open connection per log directory, opened on first use. */
const handles = new Map<string, DatabaseSync>();

/**
 * The substrate for `logDir`, or `null` when there is none.
 *
 * The file is never *created* here. This is a cache over the view the ingest
 * maintains, so where no view exists there is nothing to cache into — and a
 * read route must not leave a database behind in a log directory that had none.
 * A negative answer is deliberately not remembered: `startSubstrate` may open
 * the file after the first read went through.
 */
function handleFor(logDir: string): DatabaseSync | null {
  const held = handles.get(logDir);
  if (held) return held;
  if (!existsSync(resolveDbPath(logDir))) return null;
  try {
    const db = openDb(logDir);
    // A revision bump orphans every row it wrote; drop them rather than keep
    // rows no key can reach.
    db.prepare('DELETE FROM day_digest WHERE revision <> ?').run(REVISION);
    handles.set(logDir, db);
    return db;
  } catch {
    return null;
  }
}

/**
 * The digest an earlier process stored for `key`, or `undefined`.
 *
 * Best-effort throughout: any failure reads as a miss, and a miss only costs the
 * computation the caller would have done anyway.
 */
export function readStoredDayDigest(key: StoredDayDigestKey): UsageDigest | undefined {
  const db = handleFor(key.logDir);
  if (!db) return undefined;
  try {
    const row = db
      .prepare(SELECT)
      .get(key.backing, key.logDir, key.archiveDir, key.date, key.classifierCount, REVISION) as
      | { digest?: string }
      | undefined;
    return row?.digest === undefined ? undefined : (JSON.parse(row.digest) as UsageDigest);
  } catch {
    return undefined;
  }
}

/**
 * Keep `digest` for `key`. The caller has already decided the day is closed and
 * stable — see `cacheDayDigest` — so nothing here re-litigates that.
 *
 * The digest round-trips through JSON, which is what the routes already send it
 * as, so a stored answer is byte-identical to a computed one.
 */
export function storeDayDigest(key: StoredDayDigestKey, digest: UsageDigest): void {
  const db = handleFor(key.logDir);
  if (!db) return;
  try {
    db.prepare(INSERT).run(
      key.backing,
      key.logDir,
      key.archiveDir,
      key.date,
      key.classifierCount,
      REVISION,
      JSON.stringify(digest),
      new Date().toISOString(),
    );
  } catch {
    // A cache write that fails changes no answer.
  }
}

/**
 * Drop every stored row this process can reach and close the connections —
 * test-only, alongside `clearDayDigestMemo`.
 */
export function clearStoredDayDigests(): void {
  for (const db of handles.values()) {
    try {
      db.exec('DELETE FROM day_digest');
    } catch {
      // Closing still has to happen.
    }
    db.close();
  }
  handles.clear();
}
