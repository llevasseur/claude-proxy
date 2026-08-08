/**
 * Which sessions touched which pull request.
 *
 * Nothing records the link, so it is recovered from the transcripts: a session that
 * built a PR names its branch throughout, and one that reviewed or merged it names
 * the number. Each transcript is read once and tested against every PR, so this
 * costs one pass over `logs/sessions/` rather than one per pull request.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  matchPrInText,
  type PrSessionLink,
  type PullRequestRow,
  parseSessionTranscript,
  sessionDisplayName,
} from '@claude-proxy/core';
import { resolveSessionsDir, SESSION_FILE_RE } from './sessions.js';

/** Keyed by PR number; only PRs with at least one session appear. */
export type PrSessionIndex = Record<number, PrSessionLink[]>;

/**
 * Index the transcripts under `logDir` against `prs`.
 *
 * A missing `sessions/` directory is an empty index, not an error — the proxy may
 * simply not have written one yet.
 */
export async function readPrSessions(logDir: string, prs: readonly PullRequestRow[]): Promise<PrSessionIndex> {
  const index: PrSessionIndex = {};
  if (prs.length === 0) return index;

  const dir = resolveSessionsDir(logDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return index;
  }

  await Promise.all(
    names
      .filter((name) => SESSION_FILE_RE.test(name))
      .map(async (name) => {
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
        for (const pr of prs) {
          const via = matchPrInText(pr, content);
          if (via.length === 0) continue;
          // Parsed only once a match is certain — most transcripts match nothing.
          link ??= { threadId, title: sessionDisplayName(parseSessionTranscript(threadId, content)), modified, via };
          const entry = { ...link, via };
          const existing = index[pr.number];
          if (existing) existing.push(entry);
          else index[pr.number] = [entry];
        }
      }),
  );

  for (const links of Object.values(index)) {
    links.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  }
  return index;
}
