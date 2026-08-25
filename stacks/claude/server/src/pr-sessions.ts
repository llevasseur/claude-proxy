/**
 * Which sessions touched which pull request.
 *
 * **A session records the pull request it opened**, so the usual answer is a join rather
 * than a search: the proxy writes the url its `/pr` run was handed into the thread's
 * `.state.json`, ingest carries it into `session.pr_url`, and {@link readPrSessions} reads
 * that column first. On the substrate that is one small query.
 *
 * The transcript scan is unchanged — one pass over `logs/sessions/`, each transcript tested
 * against every pull request — but it now runs **only for the pull requests no session
 * recorded**: everything opened before the record existed, and anything opened outside a
 * captured run. Each match still says which signal found it, `recorded` included.
 *
 * Two consequences, since they are the price of the trade:
 *
 * - The scan disappears entirely only once every displayed pull request is named. The record
 *   is **forward-only** — nothing backfills it, since inventing a record out of the textual
 *   evidence it replaces is the very thing this ends — so older pull requests keep the scan
 *   alive. What it costs them is now paid once: the scan writes its links to `pr_scan` and
 *   `pr_scan_link`, and a pull request already scanned against every transcript on disk is
 *   answered from those rows instead. See {@link scannedFor}.
 * - A recorded pull request lists the session that **opened** it, not every session that
 *   mentioned it. A review run that only quoted the number no longer appears once the opener
 *   is on file.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type PrSessionLink,
  type PullRequestRow,
  parseSessionTranscript,
  prMatcher,
  prUrlKey,
  sessionDisplayName,
} from '@agent-proxy/claude-core';
import { forgetScannedPrLinks, readScannedPrLinks, type ScanToStore, storeScannedPrLinks } from './db/pr-scan-store.js';
import { fileSource, type SidecarSource } from './db/source.js';
import { resolveSessionsDir, SESSION_FILE_RE } from './sessions.js';

/** Keyed by PR number; only PRs with at least one session appear. */
export type PrSessionIndex = Record<number, PrSessionLink[]>;

/** Transcripts read at once. The whole directory in parallel is megabytes resident. */
const READ_CONCURRENCY = 16;

/** Transcripts stat'd at once. A stat holds nothing, so this is wider than the read. */
const STAT_CONCURRENCY = 64;

/** Run `each` over `items`, never more than `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, each: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) await each(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Newest first, ties broken by thread id — the order the drawer lists links in. */
function sortLinks(index: PrSessionIndex): PrSessionIndex {
  for (const links of Object.values(index)) {
    links.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  }
  return index;
}

/**
 * The recorded links among `prs`, PR number → the threads that opened it.
 *
 * A recorded url is compared by `owner/name#number`, never by number alone: the url is
 * whatever the session's own command printed, and a run that opened a pull request in
 * another repository must not be read as this one's.
 */
function recordedFor(prs: readonly PullRequestRow[], links: Map<string, string>): Map<number, string[]> {
  const byKey = new Map<string, number>();
  for (const pr of prs) {
    const key = prUrlKey(pr.url);
    // A row `gh` gave no url for has no key to match on, so it falls through to the scan.
    if (key !== null && !byKey.has(key)) byKey.set(key, pr.number);
  }
  if (byKey.size === 0) return new Map();

  const out = new Map<number, string[]>();
  for (const [threadId, url] of links) {
    const key = prUrlKey(url);
    const number = key === null ? undefined : byKey.get(key);
    if (number === undefined) continue;
    const existing = out.get(number);
    if (existing) existing.push(threadId);
    else out.set(number, [threadId]);
  }
  return out;
}

/**
 * Name the recorded threads, through the same per-thread read the session routes use.
 *
 * `readSession` rather than a listing: it is a handful of threads, both backings answer it
 * identically (the substrate re-parses a row its watermark says is behind the file), and a
 * whole-directory listing on the file backing would re-introduce the very cost this path
 * exists to avoid. A thread whose transcript has rotated away is dropped — there is
 * nothing left to link to.
 */
async function nameRecorded(
  logDir: string,
  recorded: Map<number, string[]>,
  source: SidecarSource,
): Promise<PrSessionIndex> {
  const wanted = [...new Set([...recorded.values()].flat())];
  const named = new Map<string, { title: string; modified: string }>();
  await Promise.all(
    wanted.map(async (threadId) => {
      try {
        const detail = await source.readSession(logDir, threadId);
        named.set(threadId, { title: sessionDisplayName(detail.meta), modified: detail.modified });
      } catch {
        // no transcript on disk for a thread that recorded a link
      }
    }),
  );

  const index: PrSessionIndex = {};
  for (const [number, threadIds] of recorded) {
    const links = threadIds.flatMap((threadId) => {
      const row = named.get(threadId);
      return row ? [{ threadId, title: row.title, modified: row.modified, via: ['recorded' as const] }] : [];
    });
    if (links.length) index[number] = links;
  }
  return index;
}

/**
 * Index the transcripts under `logDir` against `prs`. A missing `sessions/` directory
 * is an empty index, not an error.
 *
 * `repoDir` is the checkout the numbers belong to — the key the scan's results are stored
 * under, exactly as `pull_request` is keyed, because one log directory serves several
 * checkouts and #14 does not mean the same thing in two of them. A `null` means do not
 * store: the scan then runs in full every call, which is what it did before the table
 * existed. Recorded links are re-read every call either way, because reading them is
 * cheap and a run that opens a pull request should appear beside it at once.
 */
export async function readPrSessions(
  logDir: string,
  prs: readonly PullRequestRow[],
  repoDir: string | null = null,
  source: SidecarSource = fileSource,
): Promise<PrSessionIndex> {
  if (prs.length === 0) return {};

  const recorded = recordedFor(prs, await source.readPrLinks(logDir));
  const index = await nameRecorded(logDir, recorded, source);

  // Only what no column named. Once that is nothing, the directory is never read.
  const unnamed = prs.filter((pr) => !recorded.has(pr.number));
  if (unnamed.length === 0) return sortLinks(index);

  // Disjoint by construction — a scanned pull request is one nothing recorded — so the
  // halves are concatenated rather than merged per thread.
  const scanned = await scannedFor(logDir, repoDir, unnamed);
  for (const [number, links] of Object.entries(scanned)) index[Number(number)] = links;
  return sortLinks(index);
}

/** One transcript on disk, as the pass sees it before reading a byte of its body. */
interface Transcript {
  threadId: string;
  file: string;
  /** Epoch ms, floored — what a scan mark is compared against. */
  mtimeMs: number;
  /** The same instant as ISO 8601, which is what a link carries. */
  modified: string;
}

/**
 * Every transcript under `dir`, stat'd but unread. `null` is a missing directory.
 *
 * The stat pass says which transcripts are newer than a pull request's mark, and so
 * which of them anything has to be read from — the read being the megabytes.
 */
async function listTranscripts(dir: string): Promise<Transcript[] | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const out: Transcript[] = [];
  await inBatches(
    names.filter((name) => SESSION_FILE_RE.test(name)),
    STAT_CONCURRENCY,
    async (name) => {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        out.push({
          threadId: name.replace(/\.md$/, ''),
          file,
          mtimeMs: Math.floor(info.mtimeMs),
          modified: info.mtime.toISOString(),
        });
      } catch {
        // rotated away between the listing and the stat
      }
    },
  );
  return out;
}

/**
 * The scanned links for `prs` — from the table where a pull request has already been
 * scanned against every transcript on disk, and from a fresh pass where it has not.
 *
 * The pass narrows twice. Only the pull requests whose mark is behind the newest
 * transcript are scanned at all, and they are scanned only against the transcripts past
 * the oldest of those marks. A pull request nothing has ever scanned has no mark, so it
 * takes the whole directory once and never again.
 *
 * With no substrate to read (`repoDir` is null, or the log directory has no database)
 * this degrades to the full pass it replaced.
 */
async function scannedFor(
  logDir: string,
  repoDir: string | null,
  prs: readonly PullRequestRow[],
): Promise<PrSessionIndex> {
  const files = await listTranscripts(resolveSessionsDir(logDir));
  if (files === null) return {};

  const stored = repoDir === null ? null : readScannedPrLinks(logDir, repoDir);
  if (stored === null || repoDir === null) return sortLinks(await matchTranscripts(files, prs));

  const newest = files.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
  const onDisk = new Set(files.map((file) => file.threadId));

  // Whatever is still linkable out of the table, before anything is read.
  const index: PrSessionIndex = {};
  const rotated = new Set<string>();
  for (const pr of prs) {
    for (const link of stored.get(pr.number)?.links ?? []) {
      // A link to a transcript that has rotated away points at nothing, exactly as a
      // recorded one does. The mark stays, so losing the transcript does not buy back
      // the scan.
      if (!onDisk.has(link.threadId)) {
        rotated.add(link.threadId);
        continue;
      }
      const kept = index[pr.number];
      if (kept) kept.push({ ...link });
      else index[pr.number] = [{ ...link }];
    }
  }
  if (rotated.size > 0) forgetScannedPrLinks(logDir, [...rotated]);

  // A pull request with no mark has never been scanned; one whose mark is behind the
  // newest transcript has been, but not against everything now on disk.
  const behind = prs.filter((pr) => (stored.get(pr.number)?.scannedThrough ?? -1) < newest);
  if (behind.length === 0) return sortLinks(index);

  const cutoff = behind.reduce((min, pr) => Math.min(min, stored.get(pr.number)?.scannedThrough ?? -1), newest);
  const fresh = await matchTranscripts(
    files.filter((file) => file.mtimeMs >= cutoff),
    behind,
  );

  // Keyed by thread, because a rescan re-reads the transcript a stored link already
  // names whenever that transcript sits on the cutoff.
  for (const [key, links] of Object.entries(fresh)) {
    const number = Number(key);
    const byThread = new Map((index[number] ?? []).map((link) => [link.threadId, link]));
    for (const link of links) byThread.set(link.threadId, link);
    index[number] = [...byThread.values()];
  }

  const marks: ScanToStore[] = behind.map((pr) => ({
    number: pr.number,
    scannedThrough: newest,
    // Empty is the useful case: scanned, matched nothing, never scanned again.
    links: index[pr.number] ?? [],
  }));
  storeScannedPrLinks(logDir, repoDir, marks);

  return sortLinks(index);
}

/** Read `files` and match each against every pull request in `prs`. */
async function matchTranscripts(files: readonly Transcript[], prs: readonly PullRequestRow[]): Promise<PrSessionIndex> {
  const index: PrSessionIndex = {};
  if (prs.length === 0 || files.length === 0) return index;

  const matchers = prs.map((pr) => ({ pr, matcher: prMatcher(pr) }));

  await inBatches(files, READ_CONCURRENCY, async ({ threadId, file, modified }) => {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      return; // rotated away mid-read
    }

    let link: PrSessionLink | null = null;
    for (const { pr, matcher } of matchers) {
      const via = matcher.match(content);
      if (via.length === 0) continue;
      // Parsed only once a match is certain — most transcripts match nothing.
      link ??= { threadId, title: sessionDisplayName(parseSessionTranscript(threadId, content)), modified, via };
      const entry = { ...link, via };
      const existing = index[pr.number];
      if (existing) existing.push(entry);
      else index[pr.number] = [entry];
    }
  });

  return index;
}
