import type {
  IdeaAdd,
  IdeaAddResult,
  IdeaClaimRequest,
  IdeaClaimResult,
  IdeaComment,
  IdeaEditResult,
  IdeaFiling,
  IdeaMark,
  IdeaMarkResult,
  IdeasStore,
} from '@claude-proxy/core';
import {
  addRemoteIdeas,
  claimRemoteIdeas,
  commentRemoteIdeas,
  fetchRemoteIdeas,
  fileRemoteIdeas,
  markRemoteIdeas,
  remoteIdeasStoreLabel,
  requireRemoteIdeasStore,
} from './ideas-remote.js';

/**
 * The ideas ledger, and the only code that reaches it.
 *
 * **It is no longer a file.** The ledger lives on the `operator` Worker over D1
 * (ADR 0006), so an idea accepted on one machine is visible on every machine and
 * a new proposal is deduped against what every device already holds — including
 * the rejected rows, which are the ones that stop an idea coming back. What was
 * `<logDir>/ideas.json` is now a hosted event log replayed through
 * `packages/core/src/ideas.ts`, which stays the only place the semantics live.
 *
 * This module keeps the shape it always had — one function per verb, each
 * returning the resulting store plus what was refused — so `ideas-cli.ts`,
 * `ideas-pr.ts` and the HTTP handlers in `api.ts` did not have to learn that the
 * store moved. Three things did change, and each is deliberate:
 *
 * - **There is no `logDir` argument.** The ledger is device-independent now, so
 *   naming a device's log directory would be describing the wrong thing.
 * - **An unconfigured device throws** rather than falling back to the file. See
 *   `ideas-remote.ts` for why that is the opposite of what the concept store
 *   does, and why the opposite is right here.
 * - **`file` in the returned metadata is a URL**, not a path. It is still "where
 *   this landed", which is what every caller printed it for.
 */

/** Where the ledger lives, for a caller that reports what it wrote to. */
export function resolveIdeasPath(): string {
  return remoteIdeasStoreLabel(requireRemoteIdeasStore());
}

/**
 * Read the ledger.
 *
 * **An unreachable ledger throws**, and an empty one is empty — the same
 * distinction the file reader drew between a missing file and a corrupt one, for
 * the same reason. An idea exists nowhere else, so a caller that read the ledger
 * as empty would conclude it was fresh, re-propose everything already rejected
 * in it, and write that conclusion back.
 */
export async function readIdeasStore(): Promise<IdeasStore> {
  return fetchRemoteIdeas(requireRemoteIdeasStore());
}

/** Where a mutation landed, so a caller can name what it wrote to. */
export interface IdeasWriteMeta {
  file: string;
}

/**
 * Add, then read back.
 *
 * The read-back is what lets every caller keep rendering the rows it just
 * touched, and it is the authoritative answer rather than a local guess: the
 * store the Worker replays is the one the next device will see.
 */
export interface IdeasAddMeta {
  /** Existing slugs that look like a near-duplicate, checked against every device's ideas. */
  similar: Record<string, string[]>;
  /** Areas already in use that look like the one asked for. Reported, never refused. */
  similarAreas: Record<string, string[]>;
}

export async function addIdeasToStore(
  adds: readonly IdeaAdd[],
): Promise<IdeaAddResult & IdeasWriteMeta & IdeasAddMeta> {
  const remote = requireRemoteIdeasStore();
  const result = await addRemoteIdeas(remote, adds);
  return {
    store: await fetchRemoteIdeas(remote),
    added: result.added,
    refused: result.refused,
    similar: result.similar,
    similarAreas: result.similarAreas,
    file: remoteIdeasStoreLabel(remote),
  };
}

/** Mark, then read back. */
export async function markIdeasInStore(marks: readonly IdeaMark[]): Promise<IdeaMarkResult & IdeasWriteMeta> {
  const remote = requireRemoteIdeasStore();
  const result = await markRemoteIdeas(remote, marks);
  return { store: await fetchRemoteIdeas(remote), ...result, file: remoteIdeasStoreLabel(remote) };
}

/**
 * Re-file, then read back — the only way an idea changes area.
 *
 * Separate from {@link markIdeasInStore} for the reason on `applyIdeaFilings`: a
 * status change must never move an idea between tabs as a side effect.
 */
export async function fileIdeasInStore(filings: readonly IdeaFiling[]): Promise<IdeaEditResult & IdeasWriteMeta> {
  const remote = requireRemoteIdeasStore();
  const result = await fileRemoteIdeas(remote, filings);
  return { store: await fetchRemoteIdeas(remote), ...result, file: remoteIdeasStoreLabel(remote) };
}

/** Comment, then read back. Each write replaces the whole comment; `''` clears it. */
export async function commentIdeasInStore(comments: readonly IdeaComment[]): Promise<IdeaEditResult & IdeasWriteMeta> {
  const remote = requireRemoteIdeasStore();
  const result = await commentRemoteIdeas(remote, comments);
  return { store: await fetchRemoteIdeas(remote), ...result, file: remoteIdeasStoreLabel(remote) };
}

/**
 * Claim, then read back — the write an implementation run makes *before* it
 * starts, so a second run reads the idea as taken.
 *
 * **The race this used to concede is closed.** The file version was a
 * read-modify-write and was not atomic against a second process in the same few
 * milliseconds; it said so, and accepted a duplicate PR as the worst outcome.
 * The Worker takes the claim with a single conditional write whose `changes`
 * count decides the winner, so two runs claiming at once produce one holder and
 * one refusal naming them. See ADR 0006.
 */
export async function claimIdeasInStore(
  claims: readonly IdeaClaimRequest[],
): Promise<IdeaClaimResult & IdeasWriteMeta> {
  const remote = requireRemoteIdeasStore();
  const result = await claimRemoteIdeas(remote, claims);
  return {
    store: await fetchRemoteIdeas(remote),
    claimed: result.claimed,
    // The Worker answers in the same shape `applyIdeaClaims` returns, so a
    // refusal renders identically wherever it came from.
    refused: result.refused as IdeaClaimResult['refused'],
    unknown: result.unknown,
    file: remoteIdeasStoreLabel(remote),
  };
}
