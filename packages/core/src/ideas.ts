/**
 * The ideas ledger: features and commands somebody proposed building, and what a
 * human decided about each one.
 *
 * This is the sibling of `suggestion-status.ts`, and the two stores are
 * deliberately **separate files with separate namespaces**. They record findings
 * that argue from different evidence:
 *
 * - A *suggestion* is produced by a rule counting what a transcript did. Its
 *   evidence is the sessions it fired on, and its trace back to those sessions is
 *   what makes it safe to act on without a human in the loop.
 * - An *idea* is **invented**. Nothing counted it, so it carries no source
 *   sessions, and the only thing that makes it actionable is a recorded human
 *   sign-off — the `accepted` status below.
 *
 * Merging them would let an invented idea inherit a suggestion's trace. So
 * nothing here reads or writes `suggestion-status.json`, and nothing there reads
 * or writes `ideas.json`.
 *
 * **The key is the slug alone**, not `(repo, slug)`. The store sits beside a
 * device's logs and is shared across every repo on that machine, so the repo an
 * idea lands in is a *field* — carried as a git remote slug (`llevasseur/foo`),
 * never as an absolute checkout path, which would name a different thing on
 * another machine. Keeping the slug globally unique is what lets a dedupe check
 * be one lookup rather than a scan.
 *
 * **Unlike the suggestion store, the default status is persisted.** There, a
 * `pending` entry is dropped on read and deleted on write, so the file holds only
 * decisions. Here a `proposed` entry is kept, because the ledger's whole job is
 * to record *what was already considered* — an idea proposed and rejected must
 * never be proposed again, and the rejection reason is the most valuable row in
 * the file. A store that only kept the liked ideas would re-propose the rejected
 * ones every run.
 *
 * Pure: no I/O, no clock (callers pass `now`). The reading and writing of the
 * file lives in the server package.
 */

import { parseWriteProvenance, type WriteProvenance } from './provenance.js';

/**
 * Where an idea's evidence came from. Every one of these is a statement a
 * *person* wrote down — an unresolved question, a judge's note on a confirmed
 * finding, a shipped changelog entry, an explicit deferral. An idea with no
 * evidence of one of these kinds is invention with nothing behind it, which is
 * why {@link parseIdeaAdds} refuses one.
 */
export const IDEA_EVIDENCE_SOURCES = ['open-question', 'judge-note', 'changelog', 'deferral'] as const;

export type IdeaEvidenceSource = (typeof IDEA_EVIDENCE_SOURCES)[number];

/** True when `value` names one of the evidence sources. */
export function isIdeaEvidenceSource(value: unknown): value is IdeaEvidenceSource {
  return typeof value === 'string' && (IDEA_EVIDENCE_SOURCES as readonly string[]).includes(value);
}

/**
 * One thing an idea cites, with enough of a locator that a reader can go and
 * check it. A `judge-note` is located by `bucket`/`id` because it lives in the
 * suggestion store rather than in a file; everything else is located by `path`.
 */
export interface IdeaEvidence {
  source: IdeaEvidenceSource;
  /** Repo-relative path of the file the evidence was read from. */
  path?: string;
  /** The bucket a judge note was filed against. */
  bucket?: number;
  /** The suggestion id a judge note was filed against. */
  id?: string;
  /** What the cited thing actually says, so the citation can be checked without reopening it. */
  quote?: string;
}

/**
 * The statuses an idea moves through.
 *
 * `proposed` is the default and **is persisted** (see the module note). Only
 * `accepted` carries a human sign-off, and it is the one status `/improve` is
 * permitted to act on — a `proposed` or `rejected` idea is still invention.
 * `shipped` is set by whoever landed the PR, never by the command that proposed
 * the idea.
 *
 * `claimed` is stamped at the *start* of work, and `shipped` only once the work
 * lands. Before it existed, an entry read `accepted` for the whole span between
 * being picked up and its PR opening — unclaimed, and the only status an
 * implementing run looks for. PRs #139 and #140 both built
 * `archive-aware-window-reader` off that gap, eleven minutes apart.
 */
export const IDEA_STATUSES = ['proposed', 'accepted', 'claimed', 'rejected', 'shipped'] as const;

export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** What an idea is until a human says otherwise. */
export const DEFAULT_IDEA_STATUS: IdeaStatus = 'proposed';

/** True when `value` names one of the statuses. */
export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return typeof value === 'string' && (IDEA_STATUSES as readonly string[]).includes(value);
}

/**
 * A stable kebab-case slug — the dedupe key. Enforced rather than merely
 * documented because everything about this store's usefulness rests on two runs
 * naming the same idea the same way.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `value` is a well-formed idea slug. */
export function isIdeaSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

/**
 * A git remote slug, `owner/name`. Deliberately narrow so an absolute checkout
 * path cannot be written here: this store is device-wide and shared across every
 * repo on the machine, and a path names a different thing (or nothing) on the
 * next one.
 */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** True when `value` is a well-formed `owner/name` remote slug. */
export function isIdeaRepo(value: unknown): value is string {
  return typeof value === 'string' && REPO_PATTERN.test(value);
}

/**
 * Who is building an idea, and since when. Present only on a `claimed` entry.
 *
 * `at` is the moment work started, not the moment a PR opened.
 */
export interface IdeaClaim {
  /** The holder: a branch name, a run id, a person — whatever a second run can read and recognise as not itself. */
  by: string;
  /** ISO timestamp of the start of work. */
  at: string;
  /** The PR the claim produced, once one exists. A claim carrying this never goes stale — see {@link isIdeaClaimStale}. */
  pr?: string;
}

/**
 * How long an unevidenced claim survives before a second run may take it.
 *
 * An age-based expiry rather than a required explicit release, because a run
 * that dies cannot release its own claim and nobody would unstick it by hand.
 * It is computed at read time from the timestamp already on the entry, so a
 * claim expires with no sweeper, no heartbeat, and no write. Six hours is safe
 * only because `pr` then pins the claim open indefinitely — the long part of an
 * idea's life is the PR review, not the writing.
 */
export const IDEA_CLAIM_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * True when a claim is old enough that a second run may take the idea anyway.
 *
 * **A claim carrying a `pr` is never stale**, however old — an open PR is live
 * evidence the work exists. An unparseable `at` reads as stale, since the
 * alternative is a malformed row locking an idea permanently.
 */
export function isIdeaClaimStale(entry: IdeaEntry, now: Date = new Date()): boolean {
  const claim = entry.claim;
  if (!claim) return false;
  if (claim.pr) return false;
  const at = Date.parse(claim.at);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at >= IDEA_CLAIM_TTL_MS;
}

/** One idea on the ledger. */
export interface IdeaEntry {
  /** The stable kebab-case dedupe key. */
  slug: string;
  title: string;
  /** One paragraph on why it is worth building. */
  rationale: string;
  /** What it cites. Never empty — an idea with no evidence is not recorded. */
  evidence: IdeaEvidence[];
  /** The repo it lands in, as a git remote slug. */
  repo: string;
  status: IdeaStatus;
  /** ISO timestamp of the write that first recorded it. */
  created: string;
  /** ISO timestamp of the write that last changed its status. */
  updated: string;
  /** For `rejected`, the reason; for `shipped`, the PR url. */
  note?: string;
  /** Who is building it, present only while `status` is `claimed`. */
  claim?: IdeaClaim;
  /**
   * Who last changed the status, in the same envelope a bucket verdict carries.
   * The actor field alone — an idea is invented and has no window behind it to
   * count. Absent on every entry decided before provenance existed.
   */
  by?: WriteProvenance;
}

/** The persisted file: slug → entry. Versioned so a shape change is migrated rather than guessed at. */
export interface IdeasStore {
  version: 1;
  ideas: Record<string, IdeaEntry>;
}

/** A store with nothing recorded — what a missing file reads as. */
export function emptyIdeasStore(): IdeasStore {
  return { version: 1, ideas: {} };
}

/**
 * Read an untrusted parsed JSON value as a store, dropping anything malformed.
 *
 * A corrupt file costs the ledger it held rather than crashing a reader, which
 * matches how the suggestion store behaves. **The consequence is worth stating,
 * because it differs there:** suggestions are recomputed from the transcripts on
 * every read, so a lost flag is recoverable, while an idea exists nowhere else.
 * That is why a caller that *writes* must treat an unreadable-but-present store
 * as a stop rather than as empty — the emptiness this function reports cannot
 * tell "nothing recorded yet" from "the file is broken".
 */
export function parseIdeasStore(raw: unknown): IdeasStore {
  const store = emptyIdeasStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  const ideas = (raw as { ideas?: unknown }).ideas;
  if (!ideas || typeof ideas !== 'object' || Array.isArray(ideas)) return store;

  for (const [key, value] of Object.entries(ideas as Record<string, unknown>)) {
    if (!isIdeaSlug(key)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { title, rationale, evidence, repo, status, created, updated, note, claim, by } = value as Record<
      string,
      unknown
    >;
    if (!isIdeaStatus(status)) continue;
    if (!isIdeaRepo(repo)) continue;
    if (typeof title !== 'string' || !title.trim()) continue;
    const kept = parseEvidenceList(evidence);
    // An entry citing nothing is dropped rather than kept as a weaker one.
    if (kept.length === 0) continue;
    // A malformed claim is dropped rather than dropping the entry with it. The
    // entry then reads as unclaimed, which a second run may take.
    const parsedClaim = parseClaim(claim);
    // An unreadable envelope loses the actor, never the idea.
    const actor = parseWriteProvenance(by);
    store.ideas[key] = {
      slug: key,
      title: title.trim(),
      rationale: typeof rationale === 'string' ? rationale.trim() : '',
      evidence: kept,
      repo,
      status,
      created: typeof created === 'string' ? created : '',
      updated: typeof updated === 'string' ? updated : '',
      ...(typeof note === 'string' && note ? { note } : {}),
      ...(parsedClaim ? { claim: parsedClaim } : {}),
      ...(actor ? { by: actor } : {}),
    };
  }
  return store;
}

/** Read an untrusted value as a claim, or null when it carries no holder or no start time. */
function parseClaim(raw: unknown): IdeaClaim | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { by, at, pr } = raw as Record<string, unknown>;
  if (typeof by !== 'string' || !by.trim()) return null;
  if (typeof at !== 'string' || !at.trim()) return null;
  return {
    by: by.trim(),
    at: at.trim(),
    ...(typeof pr === 'string' && pr.trim() ? { pr: pr.trim() } : {}),
  };
}

/** Read an untrusted value as an evidence list, dropping entries with no source or no locator. */
function parseEvidenceList(raw: unknown): IdeaEvidence[] {
  if (!Array.isArray(raw)) return [];
  const kept: IdeaEvidence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { source, path, bucket, id, quote } = item as Record<string, unknown>;
    if (!isIdeaEvidenceSource(source)) continue;
    const hasPath = typeof path === 'string' && path.trim() !== '';
    const hasRef = Number.isInteger(bucket) && typeof id === 'string' && id.trim() !== '';
    if (!hasPath && !hasRef) continue;
    kept.push({
      source,
      ...(hasPath ? { path: (path as string).trim() } : {}),
      ...(Number.isInteger(bucket) ? { bucket: bucket as number } : {}),
      ...(typeof id === 'string' && id.trim() ? { id: id.trim() } : {}),
      ...(typeof quote === 'string' && quote.trim() ? { quote: quote.trim() } : {}),
    });
  }
  return kept;
}

/** The entry recorded for one slug, or null when the ledger has none. */
export function ideaOf(store: IdeasStore, slug: string): IdeaEntry | null {
  return store.ideas[slug] ?? null;
}

/** A new idea, as a caller asks for it to be recorded. */
export interface IdeaAdd {
  slug: string;
  title: string;
  rationale: string;
  evidence: IdeaEvidence[];
  repo: string;
  /** Defaults to `proposed`. An add may not claim a sign-off nobody gave. */
  status?: IdeaStatus;
  note?: string;
}

/** What {@link applyIdeaAdds} did, so a caller can report the refusals rather than swallow them. */
export interface IdeaAddResult {
  store: IdeasStore;
  /** Slugs newly written. */
  added: string[];
  /** Slugs already on the ledger, in whatever status — left exactly as they were. */
  refused: string[];
}

/**
 * Add ideas to a store, returning a new one — the input is never mutated.
 *
 * **An existing slug is refused, never overwritten**, in any status. That is the
 * point of the key: a rejected idea coming back every run is the specific
 * failure it prevents, and overwriting would erase the rejection reason that
 * made it worth keeping. The refusal is returned rather than thrown so a batch
 * of three ideas with one collision still records the other two.
 */
export function applyIdeaAdds(store: IdeasStore, adds: readonly IdeaAdd[], now: Date = new Date()): IdeaAddResult {
  const next: IdeasStore = { version: 1, ideas: { ...store.ideas } };
  const at = now.toISOString();
  const added: string[] = [];
  const refused: string[] = [];

  for (const add of adds) {
    if (next.ideas[add.slug]) {
      refused.push(add.slug);
      continue;
    }
    next.ideas[add.slug] = {
      slug: add.slug,
      title: add.title,
      rationale: add.rationale,
      evidence: add.evidence,
      repo: add.repo,
      status: add.status ?? DEFAULT_IDEA_STATUS,
      created: at,
      updated: at,
      ...(add.note ? { note: add.note } : {}),
    };
    added.push(add.slug);
  }
  return { store: next, added, refused };
}

/** A status change to one idea. */
export interface IdeaMark {
  slug: string;
  status: IdeaStatus;
  /** For `rejected`, the reason; for `shipped`, the PR url. Replaces any existing note. */
  note?: string;
  /** The marking agent's thread id. Replaces any existing attribution; absent leaves it. */
  by?: WriteProvenance;
}

/** What {@link applyIdeaMarks} did. */
export interface IdeaMarkResult {
  store: IdeasStore;
  updated: string[];
  /** Slugs no entry carries. Unlike a suggestion flag, nothing is written for these. */
  unknown: string[];
}

/**
 * Mark ideas in a store, returning a new one — the input is never mutated.
 *
 * **An unknown slug writes nothing**, which is the opposite of how a suggestion
 * flag behaves. There a flag for an id no rule currently produces is still
 * written, because the rules are recomputed and the id may come back. An idea
 * exists only in this file: a mark on a slug that is not here is a typo, and
 * inventing a titleless, evidence-free entry to hold the flag would put exactly
 * the kind of row in the ledger that {@link parseIdeasStore} drops.
 *
 * **A mark to anything but `shipped` drops the claim**, which makes
 * `ideas mark -s accepted` the explicit release beside {@link IDEA_CLAIM_TTL_MS}.
 * `shipped` keeps it, as the record of who built the thing.
 */
export function applyIdeaMarks(store: IdeasStore, marks: readonly IdeaMark[], now: Date = new Date()): IdeaMarkResult {
  const next: IdeasStore = { version: 1, ideas: { ...store.ideas } };
  const at = now.toISOString();
  const updated: string[] = [];
  const unknown: string[] = [];

  for (const mark of marks) {
    const current = next.ideas[mark.slug];
    if (!current) {
      unknown.push(mark.slug);
      continue;
    }
    const note = mark.note ?? current.note;
    // Rebuilt rather than spread-over, so `claim` is dropped by omission — a
    // `...current` spread would carry a stale holder into `accepted`.
    const { claim: _dropped, ...rest } = current;
    const by = mark.by ?? current.by;
    next.ideas[mark.slug] = {
      ...rest,
      status: mark.status,
      updated: at,
      ...(note ? { note } : {}),
      ...(mark.status === 'shipped' && current.claim ? { claim: current.claim } : {}),
      ...(by ? { by } : {}),
    };
    updated.push(mark.slug);
  }
  return { store: next, updated, unknown };
}

/** A request to take an idea, as a caller asks for it. */
export interface IdeaClaimRequest {
  slug: string;
  /** The holder to record — see {@link IdeaClaim.by}. */
  by: string;
  /** The PR, when one already exists. Usually absent: a claim is taken before there is a PR to name. */
  pr?: string;
}

/** Why one claim was refused, with enough to say who holds it instead. */
export interface IdeaClaimRefusal {
  slug: string;
  /** The status that made it unclaimable, or `claimed` when someone else holds it. */
  status: IdeaStatus;
  /** The live holder, when the refusal was a claim rather than a status. */
  heldBy?: string;
  /** When that holder took it. */
  since?: string;
  /** The PR pinning that claim open, if any. */
  pr?: string;
}

/** What {@link applyIdeaClaims} did. */
export interface IdeaClaimResult {
  store: IdeasStore;
  /** Slugs this call now holds. */
  claimed: string[];
  /** Slugs left exactly as they were, and why. */
  refused: IdeaClaimRefusal[];
  /** Slugs no entry carries. Nothing is written for these, as with a mark. */
  unknown: string[];
}

/**
 * Take ideas for implementation, returning a new store — the input is never
 * mutated. Called as the *first* step of an implementation run, not at PR-open
 * time. Only these are claimable:
 *
 * - an `accepted` entry — the signed-off, unclaimed state;
 * - a `claimed` entry whose claim is stale per {@link isIdeaClaimStale}, so a run
 *   that died does not park the idea forever;
 * - a `claimed` entry already held by the same `by`, which re-stamps `at` and can
 *   attach a `pr`. That makes claiming idempotent, so a run that retries a step
 *   does not have to distinguish "I already hold this" from "somebody does".
 *
 * Everything else is refused with the status that refused it, including
 * `proposed` — letting a claim skip the human sign-off would route around the one
 * gate `/improve` respects. Refusals are returned rather than thrown, so a batch
 * still takes the ideas that were free.
 */
export function applyIdeaClaims(
  store: IdeasStore,
  claims: readonly IdeaClaimRequest[],
  now: Date = new Date(),
): IdeaClaimResult {
  const next: IdeasStore = { version: 1, ideas: { ...store.ideas } };
  const at = now.toISOString();
  const claimed: string[] = [];
  const refused: IdeaClaimRefusal[] = [];
  const unknown: string[] = [];

  for (const request of claims) {
    const current = next.ideas[request.slug];
    if (!current) {
      unknown.push(request.slug);
      continue;
    }
    const held = current.status === 'claimed' ? current.claim : undefined;
    const takeable =
      current.status === 'accepted' ||
      (current.status === 'claimed' && (!held || held.by === request.by || isIdeaClaimStale(current, now)));
    if (!takeable) {
      refused.push({
        slug: request.slug,
        status: current.status,
        ...(held ? { heldBy: held.by, since: held.at } : {}),
        ...(held?.pr ? { pr: held.pr } : {}),
      });
      continue;
    }
    // A re-claim by the same holder keeps a PR it already recorded, so attaching
    // one is a separate call.
    const pr = request.pr ?? (held?.by === request.by ? held.pr : undefined);
    next.ideas[request.slug] = {
      ...current,
      status: 'claimed',
      updated: at,
      claim: { by: request.by, at, ...(pr ? { pr } : {}) },
    };
    claimed.push(request.slug);
  }
  return { store: next, claimed, refused, unknown };
}

/** Read untrusted input as claim requests, or throw with the first thing wrong. */
export function parseIdeaClaims(raw: unknown): IdeaClaimRequest[] {
  if (!Array.isArray(raw)) throw new Error('claims must be an array');
  if (raw.length === 0) throw new Error('claims must not be empty');

  return raw.map((item, i) => {
    const where = `claims[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} must be an object`);
    const { slug, by, pr } = item as Record<string, unknown>;
    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    if (typeof by !== 'string' || !by.trim())
      throw new Error(`${where}.by must name the holder — a branch, a run id, a person`);
    if (pr !== undefined && typeof pr !== 'string') throw new Error(`${where}.pr must be a string`);
    return { slug: slug as string, by: by.trim(), ...(pr === undefined ? {} : { pr }) };
  });
}

/**
 * Read untrusted input (a CLI's `--json`, an HTTP body) as adds, or throw with
 * the first thing wrong. **The evidence rule is enforced here**, not left to the
 * caller: an idea citing nothing is the failure mode this whole store exists to
 * suppress, so it is a parse error rather than a lint.
 */
export function parseIdeaAdds(raw: unknown): IdeaAdd[] {
  if (!Array.isArray(raw)) throw new Error('ideas must be an array');
  if (raw.length === 0) throw new Error('ideas must not be empty');

  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = `ideas[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} must be an object`);
    const { slug, title, rationale, evidence, repo, status, note } = item as Record<string, unknown>;

    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    if (seen.has(slug as string)) throw new Error(`${where}.slug repeats ${String(slug)} in the same batch`);
    seen.add(slug as string);
    if (typeof title !== 'string' || !title.trim()) throw new Error(`${where}.title must be a non-empty string`);
    if (typeof rationale !== 'string' || !rationale.trim())
      throw new Error(`${where}.rationale must be a non-empty string`);
    if (!isIdeaRepo(repo))
      throw new Error(`${where}.repo must be a git remote slug like owner/name, never a checkout path`);
    if (status !== undefined && !isIdeaStatus(status))
      throw new Error(`${where}.status must be one of ${IDEA_STATUSES.join(', ')}`);
    if (note !== undefined && typeof note !== 'string') throw new Error(`${where}.note must be a string`);

    const parsed = parseEvidenceList(evidence);
    if (parsed.length === 0) {
      throw new Error(
        `${where}.evidence must cite at least one of ${IDEA_EVIDENCE_SOURCES.join(', ')}, each with a path (or bucket + id for a judge note)`,
      );
    }
    return {
      slug: slug as string,
      title: title.trim(),
      rationale: rationale.trim(),
      evidence: parsed,
      repo: repo as string,
      ...(status === undefined ? {} : { status }),
      ...(note === undefined ? {} : { note }),
    };
  });
}

/** Read untrusted input as marks, or throw with the first thing wrong. */
export function parseIdeaMarks(raw: unknown): IdeaMark[] {
  if (!Array.isArray(raw)) throw new Error('marks must be an array');
  if (raw.length === 0) throw new Error('marks must not be empty');

  return raw.map((item, i) => {
    const where = `marks[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} must be an object`);
    const { slug, status, note, by } = item as Record<string, unknown>;
    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    if (!isIdeaStatus(status)) throw new Error(`${where}.status must be one of ${IDEA_STATUSES.join(', ')}`);
    if (note !== undefined && typeof note !== 'string') throw new Error(`${where}.note must be a string`);
    // Optional, but a malformed one throws here rather than being dropped as at
    // the store's read boundary — this input has an author to tell.
    if (by !== undefined && parseWriteProvenance(by) === null)
      throw new Error(`${where}.by must carry a 16-hex-character thread id`);
    const actor = parseWriteProvenance(by);
    return {
      slug: slug as string,
      status,
      ...(note === undefined ? {} : { note }),
      ...(actor ? { by: actor } : {}),
    };
  });
}

/** Which ideas to list. An absent field filters on nothing. */
export interface IdeaFilter {
  statuses?: readonly IdeaStatus[];
  /** A git remote slug. */
  repo?: string;
}

/**
 * The ledger as rows, oldest first — the order it was decided in, which is the
 * order a reader wants when checking what has already been considered. Ties on
 * `created` break by slug, so the output is stable across reads.
 */
export function ideaRows(store: IdeasStore, filter: IdeaFilter = {}): IdeaEntry[] {
  const statuses = filter.statuses ? new Set(filter.statuses) : null;
  return Object.values(store.ideas)
    .filter((entry) => (statuses ? statuses.has(entry.status) : true))
    .filter((entry) => (filter.repo ? entry.repo === filter.repo : true))
    .sort((a, b) => a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug));
}

/**
 * The rows an implementation run may actually take right now: `accepted`, plus
 * any `claimed` entry whose claim has gone stale.
 *
 * The two queries a run might reach for instead are both wrong: `-s accepted`
 * never recovers an idea abandoned by a dead run, and `-s accepted,claimed`
 * takes one out from under a live holder. Staleness is read at query time, so
 * no sweeper writes the file on a timer.
 */
export function claimableIdeaRows(store: IdeasStore, filter: IdeaFilter = {}, now: Date = new Date()): IdeaEntry[] {
  return ideaRows(store, { ...filter, statuses: ['accepted', 'claimed'] }).filter(
    (entry) => entry.status === 'accepted' || isIdeaClaimStale(entry, now),
  );
}

/** Totals per status over the rows given. */
export function countIdeaStatuses(rows: readonly IdeaEntry[]): Record<IdeaStatus, number> {
  const counts = Object.fromEntries(IDEA_STATUSES.map((s) => [s, 0])) as Record<IdeaStatus, number>;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** Slug tokens worth nothing as a similarity signal, being in half the slugs on any ledger. */
const STOP_TOKENS = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'command', 'add']);

/**
 * Existing slugs that look like they might already be `slug`, strongest first.
 *
 * A near-duplicate under a different name defeats the dedupe key, and only a
 * reader can actually tell `rolling-window-view` from `add-rolling-bucket-view`.
 * This is the mechanical half of that check: it surfaces candidates by shared
 * tokens so the decision is made against a short list rather than against the
 * whole ledger from memory. It deliberately does **not** refuse anything — a
 * token overlap is a prompt to look, not a verdict.
 */
export function similarIdeaSlugs(store: IdeasStore, slug: string): string[] {
  const tokens = new Set(slug.split('-').filter((t) => t && !STOP_TOKENS.has(t)));
  if (tokens.size === 0) return [];
  const scored: { slug: string; score: number }[] = [];
  for (const existing of Object.keys(store.ideas)) {
    if (existing === slug) continue;
    const other = existing.split('-').filter((t) => t && !STOP_TOKENS.has(t));
    const shared = other.filter((t) => tokens.has(t)).length;
    if (shared === 0) continue;
    // Share of the smaller token set, so a short slug inside a long one still scores high.
    scored.push({ slug: existing, score: shared / Math.min(tokens.size, other.length) });
  }
  return scored
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .map((s) => s.slug);
}
