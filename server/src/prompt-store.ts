/**
 * Read side of `logs/system-prompts/` — the content-addressed store the proxy
 * writes one outline into per distinct system prompt.
 *
 * Deliberately not date-prefixed, so retention never archives or evicts it: a
 * cohort seen months ago still has its table of contents after the request
 * bodies are gone.
 */
import crypto from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isClassifierPrompt,
  isStoredWirePrompt,
  type StoredWirePrompt,
  type WirePromptOutline,
} from '@claude-proxy/core';

export const PROMPT_STORE_DIR = 'system-prompts';

/**
 * A prompt's identity. Must stay byte-identical to `hashPrompt` in
 * `proxy/system-prompt.ts`, or a backfilled sidecar lands in a different
 * cohort than a live-captured one. Held there by
 * `server/test/wire-prompt-parity.test.ts`.
 */
export function hashWirePrompt(system: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(system ?? null))
    .digest('hex')
    .slice(0, 16);
}

export function promptStoreDir(logDir: string): string {
  return path.join(logDir, PROMPT_STORE_DIR);
}

/** One stored outline, or null when the hash was never recorded or is malformed. */
export async function readStoredPrompt(logDir: string, hash: string): Promise<StoredWirePrompt | null> {
  // Hashes come from sidecars, so refuse anything that could escape the store.
  if (!/^[0-9a-f]{8,64}$/.test(hash)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(promptStoreDir(logDir), `${hash}.json`), 'utf8'));
    return isStoredWirePrompt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every stored outline, keyed by hash. Absent store reads as empty. */
export async function readStoredPrompts(
  logDir: string,
  hashes?: Iterable<string>,
): Promise<Map<string, StoredWirePrompt>> {
  const wanted = hashes ? new Set(hashes) : null;
  let names: string[];
  try {
    names = await readdir(promptStoreDir(logDir));
  } catch {
    return new Map();
  }

  const out = new Map<string, StoredWirePrompt>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const hash = name.slice(0, -'.json'.length);
    if (wanted && !wanted.has(hash)) continue;
    const record = await readStoredPrompt(logDir, hash);
    if (record) out.set(hash, record);
  }
  return out;
}

/**
 * Verdicts by log directory, then by hash. Cached for the process lifetime
 * rather than with a TTL: the store is content-addressed, so a hash's outline
 * never changes and its verdict cannot go stale. Only hashes recorded since the
 * last call are read, which keeps a per-request refresh to one `readdir`.
 */
const classifierVerdicts = new Map<string, Map<string, boolean>>();

/** Test-only: forget the cached classifier verdicts. */
export function clearClassifierCache(): void {
  classifierVerdicts.clear();
}

/**
 * Every stored hash whose prompt is a permission-classifier prompt — what
 * `computeDigest` needs to hold auto-mode's overhead apart from real work.
 *
 * An absent store reads as an empty set, leaving every request counted as work;
 * `perCall.identified` is what records that nothing was ever checked.
 */
export async function classifierPromptHashes(logDir: string): Promise<Set<string>> {
  let seen = classifierVerdicts.get(logDir);
  if (!seen) {
    seen = new Map();
    classifierVerdicts.set(logDir, seen);
  }

  let names: string[];
  try {
    names = await readdir(promptStoreDir(logDir));
  } catch {
    names = [];
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const hash = name.slice(0, -'.json'.length);
    if (seen.has(hash)) continue;
    const record = await readStoredPrompt(logDir, hash);
    // An unreadable record stays uncached, so a partial write is retried rather
    // than remembered as "not a classifier" for the life of the process.
    if (record) seen.set(hash, isClassifierPrompt(record));
  }

  const out = new Set<string>();
  for (const [hash, yes] of seen) if (yes) out.add(hash);
  return out;
}

/**
 * Record an outline under its hash, leaving an existing record alone — the
 * first capture of a prompt is the authoritative one. Returns whether it wrote.
 */
export async function writeStoredPrompt(
  logDir: string,
  hash: string,
  outline: WirePromptOutline,
  firstSeen: string,
): Promise<boolean> {
  if (await readStoredPrompt(logDir, hash)) return false;
  const dir = promptStoreDir(logDir);
  await mkdir(dir, { recursive: true });
  const record: StoredWirePrompt = { hash, firstSeen, ...outline };
  await writeFile(path.join(dir, `${hash}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return true;
}
