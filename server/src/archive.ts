import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeDigest, type UsageDigest } from "@claude-proxy/core";

/**
 * Where finalized per-day digests live. The proxy's live `logs/` dir only keeps
 * the current day's sidecars — a daily job moves older days into a durable
 * archive laid out as `<archive>/<YYYY-MM-DD>/digest.json`. Reading those digests
 * back is what lets the trends view span more than the day or two still on disk.
 *
 * `DIGEST_ARCHIVE_DIR` overrides the location; the default matches this setup's
 * archive. If the directory is absent the archive is simply empty — the trends
 * view falls back to whatever the live `logs/` dir holds.
 */
export function resolveArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIGEST_ARCHIVE_DIR
    ? path.resolve(env.DIGEST_ARCHIVE_DIR)
    : path.join(homedir(), "Documents/logs/claude");
}

// Past days are immutable once finalized, so a digest read once never changes.
// Cache successful loads for the process lifetime, keyed by absolute file path
// (so a dir override can't collide with a stale entry). Misses aren't cached —
// a not-yet-finalized day can gain its digest while the server is running.
const cache = new Map<string, UsageDigest>();

/**
 * Load and normalize the archived digest for one calendar day, or `null` when
 * the day has no digest on disk (or it's unreadable/unparseable). Never throws —
 * a missing archive must not break the trends endpoint.
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
