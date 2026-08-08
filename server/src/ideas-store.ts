import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyIdeaAdds,
  applyIdeaClaims,
  applyIdeaComments,
  applyIdeaFilings,
  applyIdeaMarks,
  emptyIdeasStore,
  type IdeaAdd,
  type IdeaAddResult,
  type IdeaClaimRequest,
  type IdeaClaimResult,
  type IdeaComment,
  type IdeaEditResult,
  type IdeaFiling,
  type IdeaMark,
  type IdeaMarkResult,
  type IdeasStore,
  parseIdeasStore,
} from '@claude-proxy/core';

/**
 * Where the ideas ledger lives, and the only code that writes it.
 *
 * It sits beside the logs (`<logDir>/ideas.json`) for the same reason the
 * suggestion flags do — it travels with a `LOG_DIR` override and stays
 * device-local, since `logs/` is gitignored. It is a **separate file from
 * `suggestion-status.json`**, and nothing here touches that one: an idea is
 * invented and carries a human sign-off as its only trace, a suggestion is
 * counted from transcripts and carries source sessions. One evidence standard
 * per file.
 */

/** The ledger file for a log directory. */
export function resolveIdeasPath(logDir: string): string {
  return path.join(logDir, 'ideas.json');
}

/**
 * Read the ledger. A missing file is the normal starting state and reads as
 * empty.
 *
 * **A file that exists but cannot be read or parsed throws**, and that is the
 * deliberate difference from {@link readSuggestionStatusStore}. There, a corrupt
 * file reads as empty because the suggestions underneath are recomputed from the
 * transcripts on every load — the flags are the only loss, and refusing to
 * render the dashboard would be the worse failure. An idea exists **nowhere
 * else**. Reading a broken ledger as empty would let a caller conclude the
 * ledger is fresh, re-propose everything already rejected in it, and then
 * overwrite the file with that conclusion. Callers walking a store waterfall
 * depend on this distinction: a missing store is *absent* and they may fall
 * through to a lower tier, while a broken one is a **stop**.
 */
export async function readIdeasStore(logDir: string): Promise<IdeasStore> {
  const file = resolveIdeasPath(logDir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyIdeasStore();
    throw new Error(`cannot read the ideas ledger at ${file}: ${(err as Error).message}`);
  }
  try {
    return parseIdeasStore(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `the ideas ledger at ${file} exists but is not valid JSON (${(err as Error).message}) — refusing to treat it as empty, since an idea is recorded nowhere else`,
    );
  }
}

/**
 * Write the ledger through a temp file in the same directory, then rename — a
 * reader never sees a half-written file, and a crash mid-write leaves the
 * previous ledger intact.
 */
export async function writeIdeasStore(logDir: string, store: IdeasStore): Promise<string> {
  const file = resolveIdeasPath(logDir);
  await mkdir(logDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return file;
}

/** Where a mutation landed, so a caller can name the file it wrote. */
export interface IdeasWriteMeta {
  file: string;
}

/**
 * Read, add, write. Returns what was added and what was refused for an existing
 * slug, so the caller reports the collision rather than silently recording less
 * than it was asked to.
 */
export async function addIdeasToStore(
  logDir: string,
  adds: readonly IdeaAdd[],
  now: Date = new Date(),
): Promise<IdeaAddResult & IdeasWriteMeta> {
  const result = applyIdeaAdds(await readIdeasStore(logDir), adds, now);
  const file = await writeIdeasStore(logDir, result.store);
  return { ...result, file };
}

/**
 * Read, mark, write.
 *
 * Not concurrency-safe against a second writer racing between the read and the
 * rename, exactly as the suggestion store is not; the writers are one agent at a
 * time and the loss would be one entry rather than the file.
 */
export async function markIdeasInStore(
  logDir: string,
  marks: readonly IdeaMark[],
  now: Date = new Date(),
): Promise<IdeaMarkResult & IdeasWriteMeta> {
  const result = applyIdeaMarks(await readIdeasStore(logDir), marks, now);
  const file = await writeIdeasStore(logDir, result.store);
  return { ...result, file };
}

/**
 * Read, file, write — the only way an idea changes area.
 *
 * Separate from {@link markIdeasInStore} for the reason on `applyIdeaFilings`: a
 * status change must never move an idea between tabs as a side effect.
 */
export async function fileIdeasInStore(
  logDir: string,
  filings: readonly IdeaFiling[],
  now: Date = new Date(),
): Promise<IdeaEditResult & IdeasWriteMeta> {
  const result = applyIdeaFilings(await readIdeasStore(logDir), filings, now);
  const file = await writeIdeasStore(logDir, result.store);
  return { ...result, file };
}

/** Read, comment, write. Each write replaces the whole comment; `''` clears it. */
export async function commentIdeasInStore(
  logDir: string,
  comments: readonly IdeaComment[],
  now: Date = new Date(),
): Promise<IdeaEditResult & IdeasWriteMeta> {
  const result = applyIdeaComments(await readIdeasStore(logDir), comments, now);
  const file = await writeIdeasStore(logDir, result.store);
  return { ...result, file };
}

/**
 * Read, claim, write — the write an implementation run makes *before* it starts,
 * so a second run reads the idea as taken.
 *
 * **It narrows the duplicate-work window without closing it absolutely.** Like
 * the two writers above it is not atomic against a second process racing between
 * the read and the rename, so two runs claiming within the same few milliseconds
 * can both believe they won. The collision this was built for was eleven minutes
 * wide; closing the residue would mean a lock file with an owner, a timeout, and
 * a recovery path — machinery with its own stuck states, on a ledger whose worst
 * outcome is a duplicate PR.
 */
export async function claimIdeasInStore(
  logDir: string,
  claims: readonly IdeaClaimRequest[],
  now: Date = new Date(),
): Promise<IdeaClaimResult & IdeasWriteMeta> {
  const result = applyIdeaClaims(await readIdeasStore(logDir), claims, now);
  const file = await writeIdeasStore(logDir, result.store);
  return { ...result, file };
}
