import type { DatabaseSync } from "node:sqlite";
import { ingest, watchAndIngest, type IngestStats } from "./ingest.js";
import { openDb } from "./open.js";
import { dbSource, type SidecarSource } from "./source.js";

/**
 * The server's handle on the substrate. Opening it is best-effort: a failure to
 * open or ingest costs the shadow comparison and nothing else, since every route
 * still answers from the files.
 */

let handle: { db: DatabaseSync; source: SidecarSource; stop: () => void } | null = null;

/**
 * Open the substrate for `logDir`, ingest what is already on disk, and keep
 * ingesting on every change under it. Returns `null` if it cannot be opened.
 */
export function startSubstrate(logDir: string, onError: (err: Error) => void = () => undefined): SidecarSource | null {
  if (handle) return handle.source;
  try {
    const db = openDb(logDir);
    const stop = watchAndIngest(db, logDir, { onError });
    handle = { db, source: dbSource(db), stop };
    return handle.source;
  } catch (err) {
    onError(err as Error);
    return null;
  }
}

/** The running substrate's source, or `null` when it never started. */
export function substrateSource(): SidecarSource | null {
  return handle?.source ?? null;
}

/** Stop watching and close the handle — for tests and orderly shutdown. */
export function stopSubstrate(): void {
  handle?.stop();
  handle?.db.close();
  handle = null;
}

/** One-shot ingest against a freshly opened database. The `ingest` script's body. */
export async function ingestOnce(logDir: string): Promise<IngestStats> {
  const db = openDb(logDir);
  try {
    return await ingest(db, logDir);
  } finally {
    db.close();
  }
}
