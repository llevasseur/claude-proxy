/**
 * Nightly backup: commit the whole of both datasets to a private git repo. The
 * database is the source of truth for concepts *and* for ideas, so this daily
 * copy is what bounds data loss to a single day and what keeps the ADR 0004
 * carve-out honest. See ADR 0005 for the first dataset and ADR 0006 for the
 * second.
 *
 * **A dataset added to this Worker is added here too, or the carve-out is
 * unpaid.** That is the whole reason the two exports go through one loop rather
 * than one function each.
 */

import type { Db } from './db.ts';
import type { Env } from './env.ts';
import { exportIdeas } from './ideas.ts';
import { exportJsonl } from './store.ts';

export type BackupStatus = 'disabled' | 'unchanged' | 'committed';

export interface BackupResult {
  status: BackupStatus;
  bytes?: number;
  detail?: string;
}

/** What the nightly run did, per dataset. */
export interface BackupSummary {
  concepts: BackupResult;
  ideas: BackupResult;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked so a large corpus does not blow the argument limit of String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The git object id the content *would* have. GitHub's contents API returns the
 * blob sha of the file already there, so comparing against this decides whether
 * anything changed without downloading or diffing the file — and stops the cron
 * from committing an identical copy every night.
 */
async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const buffer = new Uint8Array(header.length + body.length);
  buffer.set(header, 0);
  buffer.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Commit both exports, then report on each.
 *
 * The two are committed independently rather than as one tree write: a day on
 * which only ideas moved should leave `concepts.jsonl` untouched, which is what
 * the blob-sha comparison below already buys per file.
 */
export async function runBackup(db: Db, env: Env): Promise<BackupSummary> {
  const conceptsContent = `${await exportJsonl(db)}\n`;
  const concepts = await commitFile(env, env.BACKUP_PATH || 'concepts.jsonl', conceptsContent, 'concepts', (text) =>
    text.trimEnd() === '' ? 0 : text.trimEnd().split('\n').length,
  );
  // The ideas export is one JSON object rather than JSONL, so "records" counts
  // entries rather than lines.
  const ideasContent = await exportIdeas(db);
  const ideas = await commitFile(env, env.BACKUP_IDEAS_PATH || 'ideas.json', ideasContent, 'ideas', (text) => {
    try {
      return Object.keys((JSON.parse(text) as { ideas?: Record<string, unknown> }).ideas ?? {}).length;
    } catch {
      return 0;
    }
  });
  return { concepts, ideas };
}

async function commitFile(
  env: Env,
  path: string,
  content: string,
  label: string,
  count: (text: string) => number,
): Promise<BackupResult> {
  const repo = env.BACKUP_REPO;
  const token = env.BACKUP_GITHUB_TOKEN;
  if (!repo || !token) return { status: 'disabled', detail: 'BACKUP_REPO or BACKUP_GITHUB_TOKEN is unset' };

  const branch = env.BACKUP_BRANCH || 'main';
  const lines = count(content);

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'claude-proxy-operator',
    'content-type': 'application/json',
  };
  const endpoint = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;

  const current = await fetch(`${endpoint}?ref=${encodeURIComponent(branch)}`, { headers });
  let sha: string | undefined;
  if (current.ok) {
    const existing = (await current.json()) as { sha?: string };
    sha = existing.sha;
    if (sha && sha === (await gitBlobSha(content))) return { status: 'unchanged', bytes: content.length };
  } else if (current.status !== 404) {
    throw new Error(`backup: reading ${repo}/${path} returned ${current.status}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const put = await fetch(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `chore(${label}): backup ${today} (${lines} records)`,
      content: toBase64(content),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) throw new Error(`backup: writing ${repo}/${path} returned ${put.status}`);

  return { status: 'committed', bytes: content.length, detail: `${lines} records` };
}
