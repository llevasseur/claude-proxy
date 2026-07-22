import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeDigest, type UsageDigest } from "@claude-proxy/core";

/**
 * Where finalized per-day digests live, laid out as
 * `<archive>/<YYYY-MM-DD>/digest.json`. `DIGEST_ARCHIVE_DIR` overrides the
 * location. An absent directory just yields an empty archive.
 */
export function resolveArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIGEST_ARCHIVE_DIR
    ? path.resolve(env.DIGEST_ARCHIVE_DIR)
    : path.join(homedir(), "Documents/logs/claude");
}

// Cache successful loads (keyed by absolute file path) for the process lifetime;
// finalized days are immutable. Misses aren't cached — a not-yet-finalized day
// can gain its digest while the server runs.
const cache = new Map<string, UsageDigest>();

/**
 * Load and normalize one day's archived digest, or `null` when it's missing,
 * unreadable, or unparseable. Never throws.
 */
export async function loadArchivedDigest(archiveDir: string, date: string): Promise<UsageDigest | null> {
  const file = path.join(archiveDir, date, "digest.json");
  const hit = cache.get(file);
  if (hit) return hit;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  const digest = normalizeDigest(raw, date);
  if (digest) cache.set(file, digest);
  return digest;
}

/** Test-only: drop the in-process digest cache. */
export function clearArchiveCache(): void {
  cache.clear();
}
