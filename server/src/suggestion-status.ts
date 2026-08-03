import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applySuggestionStatusUpdates,
  emptySuggestionStatusStore,
  parseSuggestionStatusStore,
  type SuggestionStatusStore,
  type SuggestionStatusUpdate,
} from '@claude-proxy/core';

/**
 * Where the suggestion flags live, and the only code that writes them.
 *
 * The file sits beside the logs it describes (`<logDir>/suggestion-status.json`)
 * rather than in the repo: the flags are about *these* transcripts, so they belong
 * with them and travel with a `LOG_DIR` override. `logs/` is gitignored, so the
 * flags are device-local by construction.
 */

/** The status file for a log directory. */
export function resolveSuggestionStatusPath(logDir: string): string {
  return path.join(logDir, 'suggestion-status.json');
}

/**
 * Read the recorded flags. A missing file is the normal starting state and reads
 * as empty; so does a corrupt one, since the suggestions underneath are recomputed
 * either way and refusing to render them would be the worse failure.
 */
export async function readSuggestionStatusStore(logDir: string): Promise<SuggestionStatusStore> {
  try {
    return parseSuggestionStatusStore(JSON.parse(await readFile(resolveSuggestionStatusPath(logDir), 'utf8')));
  } catch {
    return emptySuggestionStatusStore();
  }
}

/**
 * Write the store through a temp file in the same directory, then rename — a
 * reader (the dashboard polls) never sees a half-written file, and a crash
 * mid-write leaves the previous flags intact.
 */
export async function writeSuggestionStatusStore(logDir: string, store: SuggestionStatusStore): Promise<string> {
  const file = resolveSuggestionStatusPath(logDir);
  await mkdir(logDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return file;
}

/**
 * Read, apply, write — the single mutation the flags support. Returns the store
 * as it now stands on disk so the caller can report the result without a re-read.
 *
 * Not concurrency-safe against a second writer racing between the read and the
 * rename; the writers are one dashboard and one agent at a time, and the loss
 * would be one flag, not the file.
 */
export async function updateSuggestionStatusStore(
  logDir: string,
  updates: readonly SuggestionStatusUpdate[],
  now: Date = new Date(),
): Promise<SuggestionStatusStore> {
  const next = applySuggestionStatusUpdates(await readSuggestionStatusStore(logDir), updates, now);
  await writeSuggestionStatusStore(logDir, next);
  return next;
}
