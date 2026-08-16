import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { type PullRequestRow, parsePullRequests } from '@claude-proxy/core';
import { openDb, resolveDbPath } from './open.js';

/**
 * The `pull_request` tables: what `/api/pull-requests` answers from, and what the
 * refresh behind that answer writes to.
 *
 * The read is one indexed query; the fetch is a background pass that asks GitHub only
 * for what changed since the newest `updated_at` on file. Between them they replace a
 * `gh pr list` on the request path behind a single 60-second slot in memory.
 *
 * A row is **derived and disposable**, exactly as `day-digest-store.ts`'s rows are:
 * GitHub owns the truth, so `rm logs/claude-proxy.db` costs one full refetch and loses
 * nothing. See `docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md`.
 */

/** The last refresh's outcome for a checkout, beside the rows it wrote. */
export interface StoredPullRequestMeta {
  /** `owner/name`, or null when the remote is not GitHub. */
  repo: string | null;
  /** The setup gap the page renders as a hint — null when the refresh succeeded. */
  error: string | null;
  /** Why the rail may be out of date — a failed ref fetch, not a failed page. */
  refError: string | null;
  /** When the refresh that wrote these rows ran. */
  fetchedAt: string;
}

/** Everything a read answers with: the meta row, and the rows it describes. */
export interface StoredPullRequests extends StoredPullRequestMeta {
  prs: PullRequestRow[];
}

/** Number descending — what the page draws, and what the primary key serves without a sort. */
const SELECT_ROWS = `
SELECT document FROM pull_request WHERE repo_dir = ? ORDER BY number DESC LIMIT ?
`;

const SELECT_META = `
SELECT repo, error, ref_error AS refError, fetched_at AS fetchedAt
FROM pull_request_repo WHERE repo_dir = ?
`;

/** The watermark the refresh asks GitHub from. Served by `pull_request_updated_idx`. */
const SELECT_WATERMARK = `
SELECT MAX(updated_at) AS newest FROM pull_request WHERE repo_dir = ?
`;

/** Last write wins for a number already on file — `gh` was just asked and answered. */
const UPSERT_ROW = `
INSERT INTO pull_request (repo_dir, number, updated_at, document)
VALUES (?, ?, ?, ?)
ON CONFLICT (repo_dir, number) DO UPDATE SET updated_at = excluded.updated_at, document = excluded.document
`;

const UPSERT_META = `
INSERT INTO pull_request_repo (repo_dir, repo, error, ref_error, fetched_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (repo_dir) DO UPDATE SET
  repo = excluded.repo, error = excluded.error, ref_error = excluded.ref_error, fetched_at = excluded.fetched_at
`;

/** One open connection per log directory, opened on first use. */
const handles = new Map<string, DatabaseSync>();

/**
 * The substrate for `logDir`, or `null` when there is none.
 *
 * The file is never *created* here, for the reason `day-digest-store.ts` gives: a read
 * route must not leave a database behind in a log directory that had none. A negative
 * answer is not remembered, since the substrate may open later.
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

/**
 * What is on file for `repoDir`, or `null` when nothing is — no substrate, or a checkout
 * no refresh has landed for yet, which is what makes the caller wait for one pass rather
 * than serve an empty tree. Best-effort: any failure reads as nothing on file.
 */
export function readStoredPullRequests(logDir: string, repoDir: string, limit: number): StoredPullRequests | null {
  const db = handleFor(logDir);
  if (!db) return null;
  try {
    const meta = db.prepare(SELECT_META).get(repoDir) as
      | { repo?: string | null; error?: string | null; refError?: string | null; fetchedAt?: string }
      | undefined;
    if (!meta?.fetchedAt) return null;
    const rows = db.prepare(SELECT_ROWS).all(repoDir, limit) as { document: string }[];
    return {
      repo: meta.repo ?? null,
      error: meta.error ?? null,
      refError: meta.refError ?? null,
      fetchedAt: meta.fetchedAt,
      // Back through the fetch's own parser, so a stored answer equals a live one.
      prs: parsePullRequests(rows.map((row) => JSON.parse(row.document))),
    };
  } catch {
    return null;
  }
}

/**
 * The newest `updatedAt` on file for `repoDir` — what GitHub is asked for changes at or
 * after, rather than the last 200 pull requests again. `null` means ask for everything,
 * which is the cold case and the case after the file is deleted.
 */
export function newestPullRequestUpdate(logDir: string, repoDir: string): string | null {
  const db = handleFor(logDir);
  if (!db) return null;
  try {
    const row = db.prepare(SELECT_WATERMARK).get(repoDir) as { newest?: string | null } | undefined;
    return row?.newest ?? null;
  } catch {
    return null;
  }
}

/**
 * Land a refresh: upsert every row it returned, then record its outcome.
 *
 * One transaction, so a part-way failure leaves the previous view *and* the previous
 * `fetched_at` intact rather than a half-refreshed table claiming to be current.
 *
 * Rows are never deleted: an incremental refresh returns only what changed, so a pull
 * request the search window moved past must not vanish from the page. Returns whether
 * the write landed — `false` is a substrate that is absent or declined, and the caller's
 * answer is unaffected either way.
 */
export function storePullRequests(
  logDir: string,
  repoDir: string,
  meta: StoredPullRequestMeta,
  prs: readonly PullRequestRow[],
): boolean {
  const db = handleFor(logDir);
  if (!db) return false;
  try {
    db.exec('BEGIN');
    const row = db.prepare(UPSERT_ROW);
    for (const pr of prs) row.run(repoDir, pr.number, pr.updatedAt, JSON.stringify(pr));
    db.prepare(UPSERT_META).run(repoDir, meta.repo, meta.error, meta.refError, meta.fetchedAt);
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

/** Drop every stored row this process can reach and close the connections — test-only. */
export function clearStoredPullRequests(): void {
  for (const db of handles.values()) {
    try {
      db.exec('DELETE FROM pull_request');
      db.exec('DELETE FROM pull_request_repo');
    } catch {
      // Closing still has to happen.
    }
    db.close();
  }
  handles.clear();
}
