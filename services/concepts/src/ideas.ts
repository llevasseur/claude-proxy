/**
 * The hosted ideas ledger. See ADR 0006.
 *
 * **This file stores and replays; it decides nothing.** Every rule about what a
 * status means, what may be added over what, which area a `command-gap` may be
 * filed under and when a claim has gone stale lives in
 * `packages/core/src/ideas.ts`, and is reached from here by calling it. The one
 * deliberate exception is the claim gate at the bottom, and even that borrows
 * its cutoff from `IDEA_CLAIM_TTL_MS` rather than restating six hours in SQL.
 *
 * A read is a replay: every event, oldest first, through the matching
 * `applyIdea*`, with the event's own timestamp as `now` so `created` and
 * `updated` come out of the log rather than out of when the read ran. Live
 * claims are then overlaid from the lease table.
 */

import {
  applyIdeaAdds,
  applyIdeaComments,
  applyIdeaFilings,
  applyIdeaMarks,
  claimableIdeaRows,
  countIdeaAreas,
  countIdeaStatuses,
  emptyIdeasStore,
  IDEA_CLAIM_TTL_MS,
  type IdeaAdd,
  type IdeaAreaCounts,
  type IdeaClaim,
  type IdeaClaimRefusal,
  type IdeaClaimRequest,
  type IdeaComment,
  type IdeaEntry,
  type IdeaFiling,
  type IdeaFilter,
  type IdeaMark,
  type IdeaStatus,
  type IdeasStore,
  ideaOf,
  ideaRows,
  isIdeaClaimStale,
  isIdeaSlug,
  isIdeaTakeable,
  similarAreas,
  similarIdeaSlugs,
} from '@claude-proxy/core';
import type { Db, DbStatement } from './db.ts';
import { seedBytes, ulid } from './ulid.ts';

/** An error carrying the status the REST layer should answer with. */
export class IdeaError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'IdeaError';
    this.status = status;
  }
}

/**
 * The four things that happen to an idea and are recorded forever.
 *
 * **Claiming is deliberately absent**: it is an expiring lease rather than a
 * fact about the idea, so it lives in `idea_claim` and is taken by the
 * conditional write in {@link claimIdeas}.
 */
export type IdeaEventKind = 'add' | 'mark' | 'file' | 'comment';

interface EventRow {
  id: string;
  slug: string;
  kind: string;
  at: string;
  document: string;
}

interface ClaimRow {
  slug: string;
  holder: string;
  at: string;
  pr: string | null;
}

/**
 * The id an event gets: a ULID whose time half is the event's timestamp and
 * whose remaining bits hash the event itself.
 *
 * Same derivation the concept store uses, and it buys the same two things —
 * ids sort in replay order, and writing the same event twice writes one row.
 * That is what lets the importer run on every device, and run twice, and
 * converge rather than duplicate.
 */
async function eventId(kind: IdeaEventKind, at: string, document: string): Promise<string> {
  const parsed = Date.parse(at);
  const timeMs = Number.isNaN(parsed) ? Date.now() : parsed;
  return ulid(timeMs, await seedBytes(`${kind}${at}${document}`));
}

/** One event, ready to insert. `INSERT OR IGNORE`, so a replayed write is a no-op. */
async function eventStatement(kind: IdeaEventKind, slug: string, at: string, payload: unknown): Promise<DbStatement> {
  const document = JSON.stringify(payload);
  return {
    sql: 'INSERT OR IGNORE INTO idea_event (id, slug, kind, at, document) VALUES (?, ?, ?, ?, ?)',
    params: [await eventId(kind, at, document), slug, kind, at, document],
  };
}

/**
 * Replay the log into a store, then overlay the live claims.
 *
 * Events are applied **one at a time**, in order, rather than grouped by kind:
 * a mark and a re-file on one idea are order-dependent, and batching by kind
 * would silently reorder them.
 */
export async function readIdeas(db: Db, now: Date = new Date()): Promise<IdeasStore> {
  // `seq` rather than `id` is the tiebreaker: a derived ULID's low bits hash the
  // event, so events sharing a millisecond would otherwise replay in hash order
  // and a mark could land before the add it marks.
  const events = await db.all<EventRow>('SELECT id, slug, kind, at, document FROM idea_event ORDER BY at ASC, seq ASC');
  return overlayClaims(replay(events), await db.all<ClaimRow>('SELECT slug, holder, at, pr FROM idea_claim'), now);
}

/**
 * Fold events into a store, oldest first.
 *
 * Shared by the whole-ledger read and the by-key read below so the two cannot
 * disagree about what an event means. Every `applyIdea*` keys on the event's own
 * slug, which is exactly what makes replaying one key's events **alone** produce
 * the same entry a full replay would have produced for it.
 */
function replay(events: readonly EventRow[]): IdeasStore {
  let store = emptyIdeasStore();
  for (const event of events) {
    // A row this code cannot read is skipped rather than emptying the ledger,
    // matching how the file reader treats a malformed entry.
    let payload: unknown;
    try {
      payload = JSON.parse(event.document);
    } catch {
      continue;
    }
    const at = new Date(event.at);
    if (event.kind === 'add') store = applyIdeaAdds(store, [payload as IdeaAdd], at).store;
    else if (event.kind === 'mark') store = applyIdeaMarks(store, [payload as IdeaMark], at).store;
    else if (event.kind === 'comment') store = applyIdeaComments(store, [payload as IdeaComment], at).store;
    else if (event.kind === 'file') {
      // `applyIdeaFilings` throws on a `command-gap` idea being filed out of
      // `commands`. The write path already refused that, so a throw here would
      // mean a log the reader cannot get past — skip the one event instead.
      try {
        store = applyIdeaFilings(store, [payload as IdeaFiling], at).store;
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipping the one event is the handling — the write path already refused this, and rethrowing would make the whole ledger unreadable over a single bad row
      } catch {}
    }
  }

  return store;
}

/**
 * Attach each live lease to the idea it holds.
 *
 * **Staleness is `isIdeaClaimStale`, not a query.** A lease row outlives its
 * claim by design — expiry needs no sweeper and writes nothing — so an expired
 * row is simply not overlaid and the idea reads as takeable, exactly as it did
 * when the ledger was a file.
 *
 * `accepted` + a live lease is what `claimed` *is*; `shipped` keeps its claim as
 * the record of who built the thing but keeps its own status, since shipped is
 * terminal. A lease on any other status is ignored rather than trusted — every
 * mark but `shipped` drops the lease, so one surviving there is a leftover.
 */
function overlayClaims(store: IdeasStore, rows: readonly ClaimRow[], now: Date): IdeasStore {
  const next: IdeasStore = { version: 1, ideas: { ...store.ideas } };
  for (const row of rows) {
    const entry = next.ideas[row.slug];
    if (!entry) continue;
    const claim: IdeaClaim = { by: row.holder, at: row.at, ...(row.pr ? { pr: row.pr } : {}) };
    if (isIdeaClaimStale({ ...entry, claim }, now)) continue;
    if (entry.status === 'accepted') next.ideas[row.slug] = { ...entry, status: 'claimed', claim };
    else if (entry.status === 'shipped') next.ideas[row.slug] = { ...entry, claim };
  }
  return next;
}

/** The whole ledger as the same JSON `logs/ideas.json` held — what the export and the backup serve. */
export async function exportIdeas(db: Db, now: Date = new Date()): Promise<string> {
  return `${JSON.stringify(await readIdeas(db, now), null, 2)}\n`;
}

export interface IdeasListResult {
  rows: IdeaEntry[];
  counts: Record<IdeaStatus, number>;
  areas: IdeaAreaCounts;
  total: number;
}

/**
 * The ledger, filtered.
 *
 * `available` is `ideas list --available`: what an implementation run may take
 * right now — `accepted`, plus any `claimed` idea whose claim has expired.
 * Neither obvious alternative is right, which is why it is a flag rather than a
 * status filter a caller composes.
 */
export async function listIdeas(
  db: Db,
  filter: IdeaFilter = {},
  available = false,
  now: Date = new Date(),
): Promise<IdeasListResult> {
  const store = await readIdeas(db, now);
  const rows = available ? claimableIdeaRows(store, filter, now) : ideaRows(store, filter);
  return {
    rows,
    counts: countIdeaStatuses(rows),
    // Over the whole ledger rather than the rows returned, so a filtered view
    // still says how much it hid.
    areas: countIdeaAreas(ideaRows(store)),
    total: Object.keys(store.ideas).length,
  };
}

/**
 * One idea, by its key.
 *
 * **The key is the slug alone** — that is what `packages/core` says an idea is
 * identified by, and it is why this needs no new identifier to be queryable: the
 * dedupe key, the permalink and the argument every write already takes are the
 * same string. So this is the read that was missing rather than a new naming
 * scheme, and a caller holding a key can fetch that one idea instead of listing
 * the ledger and filtering it client-side.
 *
 * It reads **that key's own events**, which the `idea_event_slug` index serves
 * directly, so the cost is the one idea's history rather than the whole log.
 * `null` means no idea has ever been added under the key — including a key that
 * was proposed and rejected, since a rejected row is kept and still answers.
 */
export async function getIdea(db: Db, slug: string, now: Date = new Date()): Promise<IdeaEntry | null> {
  // A malformed key is the caller's mistake, not an absent idea: answering 404
  // for it would report `typo_here` as merely not on the ledger yet.
  if (!isIdeaSlug(slug)) throw new IdeaError(400, `invalid slug: ${slug} (expected a kebab-case key)`);

  const events = await db.all<EventRow>(
    'SELECT id, slug, kind, at, document FROM idea_event WHERE slug = ? ORDER BY at ASC, seq ASC',
    [slug],
  );
  if (events.length === 0) return null;

  const claims = await db.all<ClaimRow>('SELECT slug, holder, at, pr FROM idea_claim WHERE slug = ?', [slug]);
  return ideaOf(overlayClaims(replay(events), claims, now), slug);
}

export interface IdeaAddOutcome {
  added: string[];
  /** Slugs already on the ledger, in any status — left exactly as they were. */
  refused: string[];
  /** Existing slugs that look like a near-duplicate. Reported, never refused. */
  similar: Record<string, string[]>;
  /** Areas already in use that look like the one asked for. Same restraint. */
  similarAreas: Record<string, string[]>;
}

/**
 * Record proposals.
 *
 * **The dedupe check runs against the whole corpus, every device's and every
 * status', rejected rows included** — that is the thing a per-device file could
 * not do, and the reason `similar` is computed here rather than by the caller.
 * A slug already present is refused without being overwritten; the rest of the
 * batch still lands.
 */
export async function addIdeas(db: Db, adds: readonly IdeaAdd[], now: Date = new Date()): Promise<IdeaAddOutcome> {
  const store = await readIdeas(db, now);
  const result = applyIdeaAdds(store, adds, now);

  const similar: Record<string, string[]> = {};
  const areaHits: Record<string, string[]> = {};
  for (const add of adds) {
    const hits = similarIdeaSlugs(store, add.slug);
    if (hits.length > 0) similar[add.slug] = hits;
    const areas = similarAreas(store, add.area);
    if (areas.length > 0) areaHits[add.slug] = areas;
  }

  const at = now.toISOString();
  // Only what actually landed is written: an event for a refused slug would
  // replay as a second add and be refused again forever.
  const added = adds.filter((add) => result.added.includes(add.slug));
  await db.batch(await Promise.all(added.map((add) => eventStatement('add', add.slug, at, add))));

  return { added: result.added, refused: result.refused, similar, similarAreas: areaHits };
}

export interface IdeaWriteOutcome {
  updated: string[];
  /** Slugs no entry carries. Nothing is written for these — a mark on an absent slug is a typo. */
  unknown: string[];
}

/**
 * Change statuses.
 *
 * Two writes, and the second is bookkeeping rather than meaning: the event goes
 * in the log, and **every mark but `shipped` drops the lease**, which keeps the
 * lease table from disagreeing with what `applyIdeaMarks` did to the replay.
 */
export async function markIdeas(db: Db, marks: readonly IdeaMark[], now: Date = new Date()): Promise<IdeaWriteOutcome> {
  const store = await readIdeas(db, now);
  const result = applyIdeaMarks(store, marks, now);
  const at = now.toISOString();

  const landed = marks.filter((mark) => result.updated.includes(mark.slug));
  const statements = await Promise.all(landed.map((mark) => eventStatement('mark', mark.slug, at, mark)));
  for (const mark of landed) {
    if (mark.status === 'shipped') continue;
    statements.push({ sql: 'DELETE FROM idea_claim WHERE slug = ?', params: [mark.slug] });
  }
  await db.batch(statements);

  return { updated: result.updated, unknown: result.unknown };
}

/** Re-file ideas. Touches the area and nothing else — status, note and claim are left alone. */
export async function fileIdeas(
  db: Db,
  filings: readonly IdeaFiling[],
  now: Date = new Date(),
): Promise<IdeaWriteOutcome> {
  const store = await readIdeas(db, now);
  // Throws on the `command-gap` containment rule, over the whole batch before
  // anything is written — the refusal is core's, surfaced as a 400.
  let result: { updated: string[]; unknown: string[] };
  try {
    result = applyIdeaFilings(store, filings, now);
  } catch (error) {
    throw new IdeaError(400, (error as Error).message);
  }
  const at = now.toISOString();
  const landed = filings.filter((filing) => result.updated.includes(filing.slug));
  await db.batch(await Promise.all(landed.map((filing) => eventStatement('file', filing.slug, at, filing))));
  return result;
}

/** Write comments. Each write replaces the whole comment; `''` clears it. */
export async function commentIdeas(
  db: Db,
  comments: readonly IdeaComment[],
  now: Date = new Date(),
): Promise<IdeaWriteOutcome> {
  const store = await readIdeas(db, now);
  const result = applyIdeaComments(store, comments, now);
  const at = now.toISOString();
  const landed = comments.filter((comment) => result.updated.includes(comment.slug));
  await db.batch(await Promise.all(landed.map((comment) => eventStatement('comment', comment.slug, at, comment))));
  return { updated: result.updated, unknown: result.unknown };
}

export interface IdeaClaimOutcome {
  claimed: string[];
  refused: IdeaClaimRefusal[];
  unknown: string[];
}

/**
 * The take condition, as one statement.
 *
 * `ON CONFLICT … DO UPDATE … WHERE` covers both shapes at once — no lease row
 * yet (the insert lands) and a lease row that may be taken (the update lands) —
 * so there is no read between deciding and writing for a second run to slip
 * into. The `WHERE` is the three ways a claim is takeable, minus the status
 * check, which is core's and happens above:
 *
 * - `holder = excluded.holder` — already yours, so re-claiming is idempotent and
 *   is how a run attaches its PR later.
 * - `pr IS NULL AND at <= ?` — expired. **`pr IS NULL` is the whole reason this
 *   is not `at <= ?` alone**: a claim carrying a PR never goes stale by age. The
 *   comparison is inclusive because `isIdeaClaimStale` expires at `>= TTL`, and
 *   a boundary the gate and core disagree about is a claim the reader calls free
 *   and the writer refuses.
 *
 * `pr` is coalesced so a bare re-claim keeps a url the claim already had, which
 * is what `applyIdeaClaims` does with `held.pr`.
 */
const TAKE_CLAIM = `INSERT INTO idea_claim (slug, holder, at, pr) VALUES (?, ?, ?, ?)
  ON CONFLICT (slug) DO UPDATE SET
    holder = excluded.holder,
    at = excluded.at,
    pr = COALESCE(excluded.pr, idea_claim.pr)
  WHERE idea_claim.holder = excluded.holder
     OR (idea_claim.pr IS NULL AND idea_claim.at <= ?)`;

/**
 * Take ideas for implementation — the write an implementation run makes *before*
 * it starts.
 *
 * **This is the atomic conditional write ADR 0006 exists for.** The status
 * precondition is `isIdeaTakeable`, in core, checked against the replayed entry;
 * the *race* is settled by {@link TAKE_CLAIM} reporting whether it changed a
 * row. Two runs that both pass the precondition in the same millisecond produce
 * one winner and one refusal naming the winner, rather than two winners.
 */
export async function claimIdeas(
  db: Db,
  claims: readonly IdeaClaimRequest[],
  now: Date = new Date(),
): Promise<IdeaClaimOutcome> {
  const store = await readIdeas(db, now);
  const cutoff = new Date(now.getTime() - IDEA_CLAIM_TTL_MS).toISOString();
  const at = now.toISOString();

  const claimed: string[] = [];
  const refused: IdeaClaimRefusal[] = [];
  const unknown: string[] = [];

  for (const request of claims) {
    const entry = store.ideas[request.slug];
    if (!entry) {
      unknown.push(request.slug);
      continue;
    }
    // The status half of the rule, in core rather than in SQL: only an
    // `accepted` idea — or a stale or already-yours `claimed` one — may be taken.
    if (!isIdeaTakeable(entry, request.by, now)) {
      refused.push(refusalFor(entry));
      continue;
    }

    const { changes } = await db.run(TAKE_CLAIM, [
      request.slug,
      request.by,
      at,
      request.pr ?? null,
      // Bound once from the TTL in core, so six hours is stated in one place.
      cutoff,
    ]);
    if (changes > 0) {
      claimed.push(request.slug);
      continue;
    }
    // Lost the race: somebody took it between the read above and the write.
    // Re-read the lease so the refusal names whoever actually holds it.
    const [held] = await db.all<ClaimRow>('SELECT slug, holder, at, pr FROM idea_claim WHERE slug = ?', [request.slug]);
    refused.push({
      slug: request.slug,
      status: 'claimed',
      ...(held ? { heldBy: held.holder, since: held.at } : {}),
      ...(held?.pr ? { pr: held.pr } : {}),
    });
  }

  return { claimed, refused, unknown };
}

/** Why one claim was refused, with enough to say who holds it instead. */
function refusalFor(entry: IdeaEntry): IdeaClaimRefusal {
  const held = entry.status === 'claimed' ? entry.claim : undefined;
  return {
    slug: entry.slug,
    status: entry.status,
    ...(held ? { heldBy: held.by, since: held.at } : {}),
    ...(held?.pr ? { pr: held.pr } : {}),
  };
}
