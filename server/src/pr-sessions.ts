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
 *   alive, and the single-slot cache below is kept for them.
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
} from '@claude-proxy/core';
import { fileSource, type SidecarSource } from './db/source.js';
import { resolveSessionsDir, SESSION_FILE_RE } from './sessions.js';

/** Keyed by PR number; only PRs with at least one session appear. */
export type PrSessionIndex = Record<number, PrSessionLink[]>;

/** Transcripts read at once. The whole directory in parallel is megabytes resident. */
const READ_CONCURRENCY = 16;

/** Run `each` over `items`, never more than `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, each: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) await each(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

let cached: { key: string; index: PrSessionIndex } | null = null;

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
 * `cacheKey` reuses the last *scanned* index built under the same key. Recorded links are
 * re-read every call, because reading them is cheap and a run that opens a pull request
 * should appear beside it without waiting for a cache key to move.
 */
export async function readPrSessions(
  logDir: string,
  prs: readonly PullRequestRow[],
  cacheKey: string | null = null,
  source: SidecarSource = fileSource,
): Promise<PrSessionIndex> {
  if (prs.length === 0) return {};

  const recorded = recordedFor(prs, await source.readPrLinks(logDir));
  const index = await nameRecorded(logDir, recorded, source);

  // Only what no column named. Once that is nothing, the directory is never read.
  const unnamed = prs.filter((pr) => !recorded.has(pr.number));
  if (unnamed.length === 0) return sortLinks(index);

  // The key carries which pull requests were scanned, not just the fetch they came from:
  // a link recorded since the last fetch shrinks this set without moving the caller's key.
  const scanKey = cacheKey === null ? null : `${cacheKey}|${unnamed.map((pr) => pr.number).join(',')}`;
  let scanned: PrSessionIndex;
  if (scanKey !== null && cached?.key === scanKey) {
    scanned = cached.index;
  } else {
    scanned = await buildIndex(logDir, unnamed);
    if (scanKey !== null) cached = { key: scanKey, index: scanned };
  }

  // Disjoint by construction — a scanned pull request is one nothing recorded — so the
  // halves are concatenated rather than merged per thread.
  for (const [number, links] of Object.entries(scanned)) index[Number(number)] = links;
  return sortLinks(index);
}

async function buildIndex(logDir: string, prs: readonly PullRequestRow[]): Promise<PrSessionIndex> {
  const index: PrSessionIndex = {};
  if (prs.length === 0) return index;

  const dir = resolveSessionsDir(logDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return index;
  }

  const matchers = prs.map((pr) => ({ pr, matcher: prMatcher(pr) }));

  await inBatches(
    names.filter((name) => SESSION_FILE_RE.test(name)),
    READ_CONCURRENCY,
    async (name) => {
      const file = path.join(dir, name);
      let content: string;
      let modified: string;
      try {
        const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
        content = text;
        modified = info.mtime.toISOString();
      } catch {
        return; // rotated away mid-read
      }

      const threadId = name.replace(/\.md$/, '');
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
    },
  );

  return sortLinks(index);
}
