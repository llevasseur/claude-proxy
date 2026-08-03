/**
 * Read side of `logs/system-prompts/` — the content-addressed store the proxy
 * writes one outline into per distinct system prompt.
 *
 * Deliberately not date-prefixed, so retention never archives or evicts it: a
 * cohort seen months ago still has its table of contents after the request
 * bodies are gone.
 */
import crypto from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isStoredWirePrompt, type StoredWirePrompt, type WirePromptOutline } from "@claude-proxy/core";

export const PROMPT_STORE_DIR = "system-prompts";

/**
 * A prompt's identity. Must stay byte-identical to `hashPrompt` in
 * `proxy/system-prompt.mjs`, or a backfilled sidecar lands in a different
 * cohort than a live-captured one. Held there by
 * `server/test/wire-prompt-parity.test.ts`.
 */
export function hashWirePrompt(system: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(system ?? null)).digest("hex").slice(0, 16);
}

export function promptStoreDir(logDir: string): string {
  return path.join(logDir, PROMPT_STORE_DIR);
}

/** One stored outline, or null when the hash was never recorded or is malformed. */
export async function readStoredPrompt(logDir: string, hash: string): Promise<StoredWirePrompt | null> {
  // Hashes come from sidecars, so refuse anything that could escape the store.
  if (!/^[0-9a-f]{8,64}$/.test(hash)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(promptStoreDir(logDir), `${hash}.json`), "utf8"));
    return isStoredWirePrompt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every stored outline, keyed by hash. Absent store reads as empty. */
export async function readStoredPrompts(logDir: string, hashes?: Iterable<string>): Promise<Map<string, StoredWirePrompt>> {
  const wanted = hashes ? new Set(hashes) : null;
  let names: string[];
  try {
    names = await readdir(promptStoreDir(logDir));
  } catch {
    return new Map();
  }

  const out = new Map<string, StoredWirePrompt>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const hash = name.slice(0, -".json".length);
    if (wanted && !wanted.has(hash)) continue;
    const record = await readStoredPrompt(logDir, hash);
    if (record) out.set(hash, record);
  }
  return out;
}

/**
 * Record an outline under its hash, leaving an existing record alone — the
 * first capture of a prompt is the authoritative one. Returns whether it wrote.
 */
export async function writeStoredPrompt(logDir: string, hash: string, outline: WirePromptOutline, firstSeen: string): Promise<boolean> {
  if (await readStoredPrompt(logDir, hash)) return false;
  const dir = promptStoreDir(logDir);
  await mkdir(dir, { recursive: true });
  const record: StoredWirePrompt = { hash, firstSeen, ...outline };
  await writeFile(path.join(dir, `${hash}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return true;
}
