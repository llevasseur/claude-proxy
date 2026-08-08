/**
 * Which sessions touched which pull request.
 *
 * Nothing records the link, so it is recovered from the transcripts: a session names
 * either the PR's branch or its number. One pass over `logs/sessions/`, each
 * transcript tested against every PR.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type PrSessionLink,
  type PullRequestRow,
  parseSessionTranscript,
  prMatcher,
  sessionDisplayName,
} from '@claude-proxy/core';
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

/**
 * Index the transcripts under `logDir` against `prs`. A missing `sessions/` directory
 * is an empty index, not an error.
 *
 * `cacheKey` reuses the last index built under the same key. The scan reads every
 * transcript on disk, so a polling page must not repeat it per request.
 */
export async function readPrSessions(
  logDir: string,
  prs: readonly PullRequestRow[],
  cacheKey: string | null = null,
): Promise<PrSessionIndex> {
  if (cacheKey !== null && cached?.key === cacheKey) return cached.index;
  const index = await buildIndex(logDir, prs);
  if (cacheKey !== null) cached = { key: cacheKey, index };
  return index;
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

  for (const links of Object.values(index)) {
    links.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  }
  return index;
}
