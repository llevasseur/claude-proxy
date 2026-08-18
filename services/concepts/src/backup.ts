/**
 * Nightly backup: commit every hosted dataset to a private git repo. This daily
 * copy bounds data loss to a single day and keeps the ADR 0004 carve-out honest.
 *
 * **A dataset added to this Worker is added here too, or the carve-out is
 * unpaid.** That is why all exports go through one loop rather
 * than one function each.
 */

import type { Db } from './db.ts';
import type { Env } from './env.ts';
import { exportIdeas } from './ideas.ts';
import { arrayField, isJsonRecord, parseJson, recordField, textField } from './json.ts';
import { exportNotes } from './notes.ts';
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
  notes: BackupResult;
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
 * Commit every export, then report on each.
 *
 * Exports are committed independently rather than as one tree write: a day on
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
    const store = parseJson(text);
    const entries = isJsonRecord(store) ? recordField(store, 'ideas') : undefined;
    return entries === undefined ? 0 : Object.keys(entries).length;
  });
  const notesContent = await exportNotes(db);
  const notes = await commitFile(env, env.BACKUP_NOTES_PATH || 'notes.json', notesContent, 'notes', (text) => {
    const store = parseJson(text);
    const revisions = isJsonRecord(store) ? arrayField(store, 'revisions') : undefined;
    return revisions?.length ?? 0;
  });
  return { concepts, ideas, notes };
}

/** The body GitHub's contents API takes for a create-or-update of one file. */
interface ContentsWrite {
  message: string;
  /** The whole file, base64-encoded — this API has no partial write. */
  content: string;
  branch: string;
  /** The blob sha being replaced. Omitted entirely when the file does not exist yet. */
  sha?: string;
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
    const existing = parseJson(await current.text());
    sha = isJsonRecord(existing) ? textField(existing, 'sha') : undefined;
    if (sha && sha === (await gitBlobSha(content))) return { status: 'unchanged', bytes: content.length };
  } else if (current.status !== 404) {
    throw new Error(`backup: reading ${repo}/${path} returned ${current.status}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  // `sha` is present only when the file is already there: GitHub reads its absence
  // as "create", and a `sha: undefined` key would serialize away to the same thing
  // but read as though a sha had been looked up and lost.
  const commit: ContentsWrite = {
    message: `chore(${label}): backup ${today} (${lines} records)`,
    content: toBase64(content),
    branch,
  };
  if (sha) commit.sha = sha;
  const put = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(commit) });
  if (!put.ok) throw new Error(`backup: writing ${repo}/${path} returned ${put.status}`);

  return { status: 'committed', bytes: content.length, detail: `${lines} records` };
}
