/**
 * The `pr_scan` tables: what the transcript scan found, kept, so that a pull request is
 * scanned once rather than once per GitHub refresh.
 *
 * The scan is the last thing on `/api/pull-requests`'s request path. These rows replace
 * the single in-memory slot it used to be held in, one entry per pull request.
 *
 * **Only the recovered signals live here.** `via` is `branch`, `number`, or both. A
 * `recorded` link is the session's own record of the pull request it opened, is read from
 * `session.pr_url` on every request, and is never written to this table — the separation
 * `docs/features/pull-request-tree.md` guards is a column constraint here rather than a
 * convention, and {@link readScannedPrLinks} drops anything else it finds.
 *
 * A row is **derived and disposable**, exactly as `pull-request-store.ts`'s rows are:
 * `logs/sessions/` owns the truth, so `rm logs/claude-proxy.db` costs one scan pass and
 * loses nothing. See `docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md`.
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { PrSessionVia } from '@agent-proxy/claude-core';
import { openDb, resolveDbPath } from './open.js';

/** The two signals a scan can produce. `recorded` is deliberately not among them. */
const SCANNED_VIA: readonly PrSessionVia[] = ['branch', 'number'];

/** One stored link: the transcript that matched, and how. */
export interface ScannedLink {
  threadId: string;
  title: string;
  modified: string;
  via: PrSessionVia[];
}

/** What one pull request's scan left behind. */
export interface StoredScan {
  /**
   * Newest transcript mtime, epoch ms, that this pull request was scanned against.
   * The caller rescans once the directory holds something newer.
   */
  scannedThrough: number;
  /** Empty is meaningful: scanned, and nothing matched. */
  links: ScannedLink[];
}

/** One pull request's scan, as the caller hands it back to be stored. */
export interface ScanToStore extends StoredScan {
  number: number;
}

const SELECT_SCANS = `
SELECT number, scanned_through AS scannedThrough FROM pr_scan WHERE repo_dir = ?
`;

const SELECT_LINKS = `
SELECT number, thread_id AS threadId, title, modified, via FROM pr_scan_link WHERE repo_dir = ?
`;

/** Last scan wins for a number already on file — it was just run against newer transcripts. */
const UPSERT_SCAN = `
INSERT INTO pr_scan (repo_dir, number, scanned_through, scanned_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (repo_dir, number) DO UPDATE SET
  scanned_through = excluded.scanned_through, scanned_at = excluded.scanned_at
`;

const DELETE_LINKS_FOR = `DELETE FROM pr_scan_link WHERE repo_dir = ? AND number = ?`;

const INSERT_LINK = `
INSERT INTO pr_scan_link (repo_dir, number, thread_id, title, modified, via)
VALUES (?, ?, ?, ?, ?, ?)
`;

const DELETE_THREAD = `DELETE FROM pr_scan_link WHERE thread_id = ?`;

/** One open connection per log directory, opened on first use. */
const handles = new Map<string, DatabaseSync>();

/**
 * The substrate for `logDir`, or `null` when there is none.
 *
 * The file is never *created* here, for the reason `pull-request-store.ts` gives: a read
 * route must not leave a database behind in a log directory that had none. A `null` sends
 * the caller back to scanning every transcript every time — correct, just not fast.
 */
function handleFor(logDir: string): DatabaseSync | null {
  const held = handles.get(logDir);
  if (held) return held;
  if (!existsSync(resolveDbPath(logDir))) return null;
  try {
    const db = openDb(logDir);
    handles.set(logDir, db);
    return db;
  } catch {
    return null;
  }
}

/** The recovered signals in a stored `via`, in the order the matcher produces them. */
function parseVia(stored: string): PrSessionVia[] {
  const parts = new Set(stored.split(','));
  return SCANNED_VIA.filter((via) => parts.has(via));
}

/**
 * Every scan on file for `repoDir`, by pull request number — or `null` when there is no
 * substrate to read, which is the caller's signal to scan without storing.
 *
 * Read wholesale rather than by number: the table holds one row per pull request the page
 * has ever drawn, and the caller's question is about all of them at once.
 */
export function readScannedPrLinks(logDir: string, repoDir: string): Map<number, StoredScan> | null {
  const db = handleFor(logDir);
  if (!db) return null;
  try {
    const out = new Map<number, StoredScan>();
    // SAFETY: `SELECT_SCANS` names exactly number and scanned_through AS scannedThrough.
    const scans = db.prepare(SELECT_SCANS).all(repoDir) as { number: number; scannedThrough: number }[];
    for (const scan of scans) out.set(scan.number, { scannedThrough: scan.scannedThrough, links: [] });

    // SAFETY: `SELECT_LINKS` names exactly number, thread_id AS threadId, title,
    // modified and via — `via` being the stored comma list `parseVia` reads back.
    const links = db.prepare(SELECT_LINKS).all(repoDir) as {
      number: number;
      threadId: string;
      title: string;
      modified: string;
      via: string;
    }[];
    for (const link of links) {
      const scan = out.get(link.number);
      const via = parseVia(link.via);
      // A link with no recovered signal left is not a link; `recorded` never appears here.
      if (!scan || via.length === 0) continue;
      scan.links.push({ threadId: link.threadId, title: link.title, modified: link.modified, via });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Record what the scan found, one row per pull request plus one per link.
 *
 * A pull request's links are replaced wholesale rather than merged, because the caller
 * hands over the whole set it now believes in — the stored links it kept plus whatever
 * the pass just added. One transaction, so a part-way failure leaves the previous marks
 * intact and the next request rescans rather than trusting half a result.
 *
 * Returns whether the write landed. `false` is a substrate that is absent or declined,
 * and the answer the caller is about to serve is unaffected either way.
 */
export function storeScannedPrLinks(logDir: string, repoDir: string, scans: readonly ScanToStore[]): boolean {
  const db = handleFor(logDir);
  if (!db || scans.length === 0) return false;
  const scannedAt = new Date().toISOString();
  try {
    db.exec('BEGIN');
    const upsert = db.prepare(UPSERT_SCAN);
    const clear = db.prepare(DELETE_LINKS_FOR);
    const insert = db.prepare(INSERT_LINK);
    for (const scan of scans) {
      upsert.run(repoDir, scan.number, Math.floor(scan.scannedThrough), scannedAt);
      clear.run(repoDir, scan.number);
      for (const link of scan.links) {
        const via = SCANNED_VIA.filter((signal) => link.via.includes(signal));
        // The guard, on the way in as well as on the way out: a `recorded` link is not
        // this table's to hold, and a link with no recovered signal is not stored at all.
        if (via.length === 0) continue;
        insert.run(repoDir, scan.number, link.threadId, link.title, link.modified, via.join(','));
      }
    }
    db.exec('COMMIT');
    return true;
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing was open to roll back; the failure above is the whole story.
    }
    return false;
  }
}

/**
 * Drop the stored links for transcripts that are no longer on disk.
 *
 * Transcripts hold roughly today only, and a link to a rotated transcript points at
 * nothing — the recorded path drops one for the same reason. The scan mark itself stays,
 * so losing the transcript does not buy back the scan.
 */
export function forgetScannedPrLinks(logDir: string, threadIds: readonly string[]): void {
  const db = handleFor(logDir);
  if (!db || threadIds.length === 0) return;
  try {
    const remove = db.prepare(DELETE_THREAD);
    for (const threadId of threadIds) remove.run(threadId);
  } catch {
    // Best-effort tidying: a stale row is filtered on read, so failing here costs nothing.
  }
}

/** Drop every stored scan this process can reach and close the connections — test-only. */
export function clearScannedPrLinks(): void {
  for (const db of handles.values()) {
    try {
      db.exec('DELETE FROM pr_scan_link');
      db.exec('DELETE FROM pr_scan');
    } catch {
      // Closing still has to happen.
    }
    db.close();
  }
  handles.clear();
}
