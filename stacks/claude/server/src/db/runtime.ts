import type { DatabaseSync } from 'node:sqlite';
import { asError } from '../errors.js';
import { type IngestStats, ingest, watchAndIngest } from './ingest.js';
import { openDb } from './open.js';
import { dbSource, fileSource, type SidecarSource } from './source.js';

/**
 * The server's handle on the substrate. Opening it is best-effort: a failure to
 * open or ingest drops every route back onto the file scan, which is still a
 * complete answer — the database is a view over files that never went anywhere.
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
  } catch (cause) {
    onError(asError(cause));
    return null;
  }
}

/** The running substrate's source, or `null` when it never started. */
export function substrateSource(): SidecarSource | null {
  return handle?.source ?? null;
}

/**
 * The reversal, in one flag: on unless `DB_READS=0`, which puts every route back
 * on the directory scan. There is no migration to undo — the log files were
 * never touched, so the file scan still answers every route.
 */
export function dbReadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.DB_READS;
  return v !== '0' && v !== 'false';
}

/**
 * The source a route reads through: the substrate by default, the files when the
 * flag says so or when the substrate could not be opened at all. The single
 * place that choice is made, so no route can drift from the rest.
 */
export function readSource(): SidecarSource {
  return dbReadsEnabled() ? (handle?.source ?? fileSource) : fileSource;
}

/**
 * The side that was *not* served, for shadow mode to check the served answer
 * against. `null` when the substrate never opened and both sides would be the
 * files.
 */
export function shadowSource(): SidecarSource | null {
  if (readSource().kind === 'db') return fileSource;
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
