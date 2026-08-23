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

import { type JsonValue, jsonArray, jsonObject, jsonText, jsonValueOf, objectAt } from './json.js';
import { parseWriteProvenance, type WriteProvenance } from './provenance.js';
import { CLAUDE_SERVER_PACKAGE } from './workspace-packages.js';

/**
 * Where an idea's evidence came from. The first four are each a statement a
 * *person* wrote down — an unresolved question, a judge's note on a confirmed
 * finding, a shipped changelog entry, an explicit deferral. An idea with no
 * evidence of one of these kinds is invention with nothing behind it, which is
 * why {@link parseIdeaAdds} refuses one.
 *
 * `command-gap` is the odd one out: it cites the *absence* of a command, so it
 * carries **no locator** and is the one citation a reader cannot go and check.
 * Contained by {@link IDEA_COMMAND_AREA}; both rules are in {@link parseIdeaAdds}.
 */
export const IDEA_EVIDENCE_SOURCES = ['open-question', 'judge-note', 'changelog', 'deferral', 'command-gap'] as const;

export type IdeaEvidenceSource = (typeof IDEA_EVIDENCE_SOURCES)[number];

/**
 * The one source that may stand alone, with no path and no bucket/id.
 *
 * Everything else must say where it was read, because that locator is what lets
 * a reader check the citation rather than take it on trust.
 */
const LOCATORLESS_SOURCE: IdeaEvidenceSource = 'command-gap';

/**
 * The single area string this module ascribes meaning to.
 *
 * **The area vocabulary is otherwise free text** — {@link SEED_IDEA_AREAS} is
 * advisory and any kebab string is a valid area. This one constant is the
 * deliberate exception, and it exists to contain {@link LOCATORLESS_SOURCE}: a
 * `command-gap` cites a command that was never written, so it carries no
 * locator, and an uncheckable citation is only tolerable where it is the *only*
 * citation available. Confining it to the Commands area is what stops "no file
 * to point at" becoming the universal excuse for evidence-free invention. Both
 * rules are enforced at the parse boundary, in {@link parseIdeaAdds}.
 */
export const IDEA_COMMAND_AREA = 'commands';

/**
 * True when `value` names one of the evidence sources.
 *
 * Generic like the other predicates here ({@link isIdeaStatus}, {@link isIdeaSlug},
 * {@link isIdeaArea}, {@link isIdeaRepo}, {@link isIdeaPrOutcome}): the caller —
 * a query-string fragment or a decoded `JsonValue` — keeps its own type alongside
 * the answer.
 */
export function isIdeaEvidenceSource<Candidate>(value: Candidate): value is Candidate & IdeaEvidenceSource {
  const text = jsonText(jsonValueOf(value));
  return IDEA_EVIDENCE_SOURCES.some((source) => source === text);
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

/** True when `value` names one of the statuses. Generic per {@link isIdeaEvidenceSource}. */
export function isIdeaStatus<Candidate>(value: Candidate): value is Candidate & IdeaStatus {
  const text = jsonText(jsonValueOf(value));
  return IDEA_STATUSES.some((status) => status === text);
}

/**
 * True when an idea in this status may be marked `shipped`.
 *
 * `claimed` is the ordinary case, `accepted` the released one — letting a claim
 * go does not un-land a PR that merged, so the mark stays reachable without
 * re-claiming first. `shipped` is terminal, per {@link planIdeaPrTransitions};
 * `proposed` and `rejected` carry no sign-off.
 *
 * A predicate rather than a check inside {@link applyIdeaMarks}, since the
 * dashboard decides whether to offer the control before there is a mark.
 */
export function canShipIdea(status: IdeaStatus): boolean {
  return status === 'accepted' || status === 'claimed';
}

/**
 * A stable kebab-case slug — the dedupe key. Enforced rather than merely
 * documented because everything about this store's usefulness rests on two runs
 * naming the same idea the same way.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `value` is a well-formed idea slug. Generic per {@link isIdeaEvidenceSource}. */
export function isIdeaSlug<Candidate>(value: Candidate): value is Candidate & string {
  const text = jsonText(jsonValueOf(value));
  return text !== null && SLUG_PATTERN.test(text);
}

/**
 * True when `value` is a well-formed area — the same kebab shape a slug takes.
 *
 * **Shape is the whole check** — there is no allow-list, and an area nothing here
 * has heard of is still a valid one. What the shape buys is that two runs writing
 * the same area write the same string.
 */
export function isIdeaArea<Candidate>(value: Candidate): value is Candidate & string {
  const text = jsonText(jsonValueOf(value));
  return text !== null && SLUG_PATTERN.test(text);
}

/**
 * The areas worth suggesting, in the order a reader should meet them.
 *
 * **Advisory only** — the tab order, the display labels, and the list the CLI's
 * help prints, never a constraint. {@link parseIdeaAdds} accepts any area passing
 * {@link isIdeaArea}, and an invented one gets a tab of its own beside these.
 */
export const SEED_IDEA_AREAS: readonly { area: string; label: string }[] = [
  { area: 'ui-ux', label: 'UI/UX' },
  { area: 'infrastructure', label: 'Infrastructure' },
  { area: 'code-quality', label: 'Code Quality' },
  { area: 'services', label: 'Services' },
  { area: IDEA_COMMAND_AREA, label: 'Commands' },
];

/** What a row with no area reads as — legacy rows written before areas existed. */
export const UNFILED_IDEA_AREA_LABEL = 'Unfiled';

/**
 * The display label for an area: the seed's if it has one, else the area itself
 * title-cased enough to read as a heading rather than as a key.
 */
export function ideaAreaLabel(area: string | undefined): string {
  if (!area) return UNFILED_IDEA_AREA_LABEL;
  const seed = SEED_IDEA_AREAS.find((s) => s.area === area);
  if (seed) return seed.label;
  return area
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * A git remote slug, `owner/name`. Deliberately narrow so an absolute checkout
 * path cannot be written here: this store is device-wide and shared across every
 * repo on the machine, and a path names a different thing (or nothing) on the
 * next one.
 */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** True when `value` is a well-formed `owner/name` remote slug. Generic per {@link isIdeaEvidenceSource}. */
export function isIdeaRepo<Candidate>(value: Candidate): value is Candidate & string {
  const text = jsonText(jsonValueOf(value));
  return text !== null && REPO_PATTERN.test(text);
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
  /**
   * Why it is worth building. Written by `/ideate` as literal `- ` bullet lines;
   * a row written before that shape carries one paragraph and stays that way.
   * {@link ideaRationaleBullets} tells the two apart for whoever renders it.
   */
  rationale: string;
  /** What it cites. Never empty — an idea with no evidence is not recorded. */
  evidence: IdeaEvidence[];
  /** The repo it lands in, as a git remote slug. */
  repo: string;
  /**
   * What kind of thing it is — the tab it files under.
   *
   * **Required on the way in and optional on the way out.** {@link parseIdeaAdds}
   * refuses an entry without one, so nothing new lands unfiled.
   * {@link parseIdeasStore} tolerates its absence, since dropping the rows written
   * before areas existed would discard the rejection reasons the dedupe check
   * reads. Those show as {@link UNFILED_IDEA_AREA_LABEL} until someone files them.
   */
  area?: string;
  status: IdeaStatus;
  /** ISO timestamp of the write that first recorded it. */
  created: string;
  /** ISO timestamp of the write that last changed it — a decision, a re-file, or a comment. */
  updated: string;
  /** For `rejected`, the reason; for `shipped`, the PR url. */
  note?: string;
  /**
   * A human's own words about the idea — build notes, scope, a caveat.
   *
   * **Deliberately not {@link IdeaEntry.note}**, which is machinery a dedupe check
   * reads: a rejection's reason, or a shipped entry's PR url. Overwritten on each
   * edit rather than appended to — it is the current instruction, not a log.
   */
  comment?: string;
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
export function parseIdeasStore<Candidate>(raw: Candidate): IdeasStore {
  const store = emptyIdeasStore();
  const ideas = objectAt(jsonObject(jsonValueOf(raw)), 'ideas');
  if (ideas === null) return store;

  for (const [key, value] of Object.entries(ideas)) {
    if (!isIdeaSlug(key)) continue;
    const record = jsonObject(value);
    if (record === null) continue;
    const status = record.status;
    if (!isIdeaStatus(status)) continue;
    const repo = record.repo;
    if (!isIdeaRepo(repo)) continue;
    const title = (jsonText(record.title) ?? '').trim();
    if (!title) continue;
    const kept = parseEvidenceList(record.evidence);
    // An entry citing nothing is dropped rather than kept as a weaker one.
    if (kept.length === 0) continue;

    const entry: IdeaEntry = {
      slug: key,
      title,
      rationale: (jsonText(record.rationale) ?? '').trim(),
      evidence: kept,
      repo,
      status,
      created: jsonText(record.created) ?? '',
      updated: jsonText(record.updated) ?? '',
    };
    // Area is tolerated absent, and a malformed one is dropped rather than
    // dropping the entry: an idea filed under `Not An Area` reads as Unfiled,
    // which is fixable from the dashboard, where a dropped row is not.
    const area = record.area;
    if (isIdeaArea(area)) entry.area = area;
    const note = jsonText(record.note);
    if (note) entry.note = note;
    const comment = (jsonText(record.comment) ?? '').trim();
    if (comment) entry.comment = comment;
    // A malformed claim is dropped rather than dropping the entry with it. The
    // entry then reads as unclaimed, which a second run may take.
    const claim = parseClaim(record.claim);
    if (claim) entry.claim = claim;
    // An unreadable envelope loses the actor, never the idea.
    const actor = parseWriteProvenance(record.by);
    if (actor) entry.by = actor;
    store.ideas[key] = entry;
  }
  return store;
}

/** Read an untrusted value as a claim, or null when it carries no holder or no start time. */
function parseClaim(raw: JsonValue | undefined): IdeaClaim | null {
  const record = jsonObject(raw);
  if (record === null) return null;
  const by = (jsonText(record.by) ?? '').trim();
  if (!by) return null;
  const at = (jsonText(record.at) ?? '').trim();
  if (!at) return null;
  const claim: IdeaClaim = { by, at };
  const pr = (jsonText(record.pr) ?? '').trim();
  if (pr) claim.pr = pr;
  return claim;
}

/**
 * Read an untrusted value as an evidence list, dropping entries with no source
 * or no locator — except {@link LOCATORLESS_SOURCE}, which has nothing to locate
 * and stands alone. Which *areas* may carry that one is a separate rule, checked
 * in {@link parseIdeaAdds} where the area is in hand.
 */
function parseEvidenceList(raw: JsonValue | undefined): IdeaEvidence[] {
  const items = jsonArray(raw);
  if (items === null) return [];
  const kept: IdeaEvidence[] = [];
  for (const item of items) {
    const record = jsonObject(item);
    if (record === null) continue;
    const source = record.source;
    if (!isIdeaEvidenceSource(source)) continue;
    const path = (jsonText(record.path) ?? '').trim();
    const bucket = record.bucket;
    const hasBucket = Number.isInteger(bucket);
    const id = (jsonText(record.id) ?? '').trim();
    if (path === '' && !(hasBucket && id !== '') && source !== LOCATORLESS_SOURCE) continue;

    const evidence: IdeaEvidence = { source };
    if (path) evidence.path = path;
    // Guarded by the same `Number.isInteger`, which is only true of a number.
    if (hasBucket) evidence.bucket = Number(bucket);
    if (id) evidence.id = id;
    const quote = (jsonText(record.quote) ?? '').trim();
    if (quote) evidence.quote = quote;
    kept.push(evidence);
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
  /** Required here, unlike on {@link IdeaEntry} — nothing new lands unfiled. */
  area: string;
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
    const entry: IdeaEntry = {
      slug: add.slug,
      title: add.title,
      rationale: add.rationale,
      evidence: add.evidence,
      repo: add.repo,
      status: add.status ?? DEFAULT_IDEA_STATUS,
      created: at,
      updated: at,
    };
    if (add.area) entry.area = add.area;
    if (add.note) entry.note = add.note;
    next.ideas[add.slug] = entry;
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
    const entry: IdeaEntry = { ...rest, status: mark.status, updated: at };
    if (note) entry.note = note;
    if (mark.status === 'shipped' && current.claim) entry.claim = current.claim;
    if (by) entry.by = by;
    next.ideas[mark.slug] = entry;
    updated.push(mark.slug);
  }
  return { store: next, updated, unknown };
}

/** A re-filing: which idea, and the area it belongs under. */
export interface IdeaFiling {
  slug: string;
  area: string;
  /** Who re-filed it. Replaces any existing attribution; absent leaves it. */
  by?: WriteProvenance;
}

/** A comment written on one idea. */
export interface IdeaComment {
  slug: string;
  /** The whole comment. **Overwrites** any existing one — this is not an append. */
  text: string;
  /** Who wrote it. Replaces any existing attribution; absent leaves it. */
  by?: WriteProvenance;
}

/** What {@link applyIdeaFilings} or {@link applyIdeaComments} did. */
export interface IdeaEditResult {
  store: IdeasStore;
  updated: string[];
  /** Slugs no entry carries. Nothing is written for these, as with a mark. */
  unknown: string[];
}

/**
 * File ideas under an area, returning a new store — the input is never mutated.
 *
 * **Deliberately not folded into {@link applyIdeaMarks}**: a single verb doing
 * both would let a status change move an idea between tabs as a side effect, or a
 * re-file quietly reset a rejection. **`status`, `note` and `claim` are left
 * exactly as they were.**
 *
 * The one refusal is {@link IDEA_COMMAND_AREA} containment — re-filing is the only
 * way past {@link parseIdeaAdds} into the state it forbids. Checked over the whole
 * batch before anything is written, rather than half-applied and then thrown.
 */
export function applyIdeaFilings(
  store: IdeasStore,
  filings: readonly IdeaFiling[],
  now: Date = new Date(),
): IdeaEditResult {
  for (const filing of filings) {
    const current = store.ideas[filing.slug];
    if (!current || filing.area === IDEA_COMMAND_AREA) continue;
    if (current.evidence.some((e) => e.source === LOCATORLESS_SOURCE)) {
      throw new Error(
        `${filing.slug} cites ${LOCATORLESS_SOURCE}, which carries no locator and so is confined to the ${IDEA_COMMAND_AREA} area — it cannot be filed under ${filing.area}`,
      );
    }
  }

  const next: IdeasStore = { version: 1, ideas: { ...store.ideas } };
  const at = now.toISOString();
  const updated: string[] = [];
  const unknown: string[] = [];

  for (const filing of filings) {
    const current = next.ideas[filing.slug];
    if (!current) {
      unknown.push(filing.slug);
      continue;
    }
    const by = filing.by ?? current.by;
    const entry: IdeaEntry = { ...current, area: filing.area, updated: at };
    if (by) entry.by = by;
    next.ideas[filing.slug] = entry;
    updated.push(filing.slug);
  }
  return { store: next, updated, unknown };
}

/**
 * Write comments on ideas, returning a new store — the input is never mutated.
 *
 * Each write **replaces** the whole comment, and an empty one clears it. See
 * {@link IdeaEntry.comment} for why this is a separate field from `note`.
 */
export function applyIdeaComments(
  store: IdeasStore,
  comments: readonly IdeaComment[],
  now: Date = new Date(),
): IdeaEditResult {
  const next: IdeasStore = { version: 1, ideas: { ...store.ideas } };
  const at = now.toISOString();
  const updated: string[] = [];
  const unknown: string[] = [];

  for (const comment of comments) {
    const current = next.ideas[comment.slug];
    if (!current) {
      unknown.push(comment.slug);
      continue;
    }
    const text = comment.text.trim();
    const by = comment.by ?? current.by;
    // Rebuilt rather than spread-over, so an emptied comment is dropped by
    // omission rather than persisted as `""`.
    const { comment: _replaced, ...rest } = current;
    const entry: IdeaEntry = { ...rest, updated: at };
    if (text) entry.comment = text;
    if (by) entry.by = by;
    next.ideas[comment.slug] = entry;
    updated.push(comment.slug);
  }
  return { store: next, updated, unknown };
}

/** Read untrusted input as filings, or throw with the first thing wrong. */
export function parseIdeaFilings<Candidate>(raw: Candidate): IdeaFiling[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('filings must be an array');
  if (items.length === 0) throw new Error('filings must not be empty');

  return items.map((item, i) => {
    const where = `filings[${i}]`;
    const record = jsonObject(item);
    if (record === null) throw new Error(`${where} must be an object`);
    const { slug, area, by } = record;
    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    if (!isIdeaArea(area)) throw new Error(`${where}.area must be a kebab-case area (a-z, 0-9, single dashes)`);
    if (by !== undefined && parseWriteProvenance(by) === null)
      throw new Error(`${where}.by must carry a 16-hex-character thread id`);
    const actor = parseWriteProvenance(by);
    const filing: IdeaFiling = { slug, area };
    if (actor) filing.by = actor;
    return filing;
  });
}

/** Read untrusted input as comments, or throw with the first thing wrong. */
export function parseIdeaComments<Candidate>(raw: Candidate): IdeaComment[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('comments must be an array');
  if (items.length === 0) throw new Error('comments must not be empty');

  return items.map((item, i) => {
    const where = `comments[${i}]`;
    const record = jsonObject(item);
    if (record === null) throw new Error(`${where} must be an object`);
    const { slug, by } = record;
    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    // An empty string is the clear, so it is accepted where a missing field is not.
    const text = jsonText(record.text);
    if (text === null) throw new Error(`${where}.text must be a string ('' clears the comment)`);
    if (by !== undefined && parseWriteProvenance(by) === null)
      throw new Error(`${where}.by must carry a 16-hex-character thread id`);
    const actor = parseWriteProvenance(by);
    const comment: IdeaComment = { slug, text };
    if (actor) comment.by = actor;
    return comment;
  });
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
 * True when `by` may take this entry right now. The whole claimability rule, and
 * the three ways an idea is takeable:
 *
 * - an `accepted` entry — the signed-off, unclaimed state;
 * - a `claimed` entry whose claim is stale per {@link isIdeaClaimStale}, so a run
 *   that died does not park the idea forever;
 * - a `claimed` entry already held by the same `by`, which makes claiming
 *   idempotent — a run that retries a step does not have to distinguish "I
 *   already hold this" from "somebody does".
 *
 * Everything else is refused, including `proposed` — letting a claim skip the
 * human sign-off would route around the one gate `/improve` respects.
 *
 * {@link applyIdeaClaims} is its only enforcement point.
 */
export function isIdeaTakeable(entry: IdeaEntry, by: string, now: Date = new Date()): boolean {
  if (entry.status === 'accepted') return true;
  if (entry.status !== 'claimed') return false;
  const held = entry.claim;
  return !held || held.by === by || isIdeaClaimStale(entry, now);
}

/**
 * Take ideas for implementation, returning a new store — the input is never
 * mutated. Called as the *first* step of an implementation run, not at PR-open
 * time. What may be taken is {@link isIdeaTakeable}; everything else is refused
 * with the status that refused it. Refusals are returned rather than thrown, so
 * a batch still takes the ideas that were free.
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
    if (!isIdeaTakeable(current, request.by, now)) {
      const refusal: IdeaClaimRefusal = { slug: request.slug, status: current.status };
      if (held) {
        refusal.heldBy = held.by;
        refusal.since = held.at;
      }
      if (held?.pr) refusal.pr = held.pr;
      refused.push(refusal);
      continue;
    }
    // A re-claim by the same holder keeps a PR it already recorded, so attaching
    // one is a separate call.
    const pr = request.pr ?? (held?.by === request.by ? held.pr : undefined);
    const claim: IdeaClaim = { by: request.by, at };
    if (pr) claim.pr = pr;
    next.ideas[request.slug] = { ...current, status: 'claimed', updated: at, claim };
    claimed.push(request.slug);
  }
  return { store: next, claimed, refused, unknown };
}

/** Read untrusted input as claim requests, or throw with the first thing wrong. */
export function parseIdeaClaims<Candidate>(raw: Candidate): IdeaClaimRequest[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('claims must be an array');
  if (items.length === 0) throw new Error('claims must not be empty');

  return items.map((item, i) => {
    const where = `claims[${i}]`;
    const record = jsonObject(item);
    if (record === null) throw new Error(`${where} must be an object`);
    const { slug, pr } = record;
    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    const holder = jsonText(record.by);
    if (holder === null || !holder.trim())
      throw new Error(`${where}.by must name the holder — a branch, a run id, a person`);
    const prText = jsonText(pr);
    if (pr !== undefined && prText === null) throw new Error(`${where}.pr must be a string`);
    const request: IdeaClaimRequest = { slug, by: holder.trim() };
    if (prText !== null) request.pr = prText;
    return request;
  });
}

/**
 * What GitHub says about a PR the ledger has linked, reduced to the four
 * outcomes a claim reacts to.
 *
 * **`detached` is not a PR state**: an open PR whose head branch has been
 * deleted. Reading it as `open` would leave the idea claimed forever, because
 * {@link isIdeaClaimStale} never expires a claim carrying a `pr`.
 */
export const IDEA_PR_OUTCOMES = ['open', 'merged', 'closed', 'detached'] as const;

export type IdeaPrOutcome = (typeof IDEA_PR_OUTCOMES)[number];

/** True when `value` names one of the PR outcomes. Generic per {@link isIdeaEvidenceSource}. */
export function isIdeaPrOutcome<Candidate>(value: Candidate): value is Candidate & IdeaPrOutcome {
  const text = jsonText(jsonValueOf(value));
  return IDEA_PR_OUTCOMES.some((outcome) => outcome === text);
}

/** What was observed about one linked PR. The observing happens elsewhere — this module has no I/O. */
export interface IdeaPrObservation {
  /** The PR url, matched against the ledger's by {@link sameIdeaPr}. */
  pr: string;
  outcome: IdeaPrOutcome;
}

/** An idea the ledger has a PR for, and the status that PR is currently pinning. */
export interface IdeaPrLink {
  slug: string;
  status: IdeaStatus;
  pr: string;
}

/**
 * Absorbs a trailing slash and surrounding whitespace, the differences between a
 * url typed into `ideas claim` and one `gh` returns. Case is **not** folded — a
 * GitHub path is case-sensitive.
 */
function normalizePr(pr: string): string {
  return pr.trim().replace(/\/+$/, '');
}

/** True when two recorded PR urls name the same pull request. */
export function sameIdeaPr(a: string, b: string): boolean {
  return normalizePr(a) === normalizePr(b);
}

/**
 * Every entry carrying a PR url — `claimed` and `shipped` and nothing else,
 * since the url lives on {@link IdeaClaim} and every mark except `shipped` drops
 * the claim.
 */
export function ideaPrLinks(store: IdeasStore): IdeaPrLink[] {
  return ideaRows(store)
    .filter((entry) => entry.claim?.pr)
    .map((entry) => ({ slug: entry.slug, status: entry.status, pr: entry.claim?.pr ?? '' }));
}

/** One status change a PR's outcome implies, with the sentence explaining it. */
export interface IdeaPrTransition {
  slug: string;
  pr: string;
  from: IdeaStatus;
  to: IdeaStatus;
  outcome: IdeaPrOutcome;
  /** Why, phrased for a log line. */
  why: string;
}

/** What {@link planIdeaPrTransitions} decided, in full, before anything is written. */
export interface IdeaPrPlan {
  /** The changes to make, oldest idea first. */
  transitions: IdeaPrTransition[];
  /** The same changes, as {@link applyIdeaMarks} input. */
  marks: IdeaMark[];
  /** Linked entries whose PR was observed and implies no change. */
  unchanged: IdeaPrLink[];
  /** Linked entries no observation covered. **Left alone** — an unobserved PR is missing data, never evidence. */
  unobserved: IdeaPrLink[];
}

/**
 * Decide what a batch of observed PRs does to the ledger. Pure: it plans, and a
 * caller writes. The rules, all of them on `claimed` entries:
 *
 * - **merged → `shipped`**, with the PR url as the note — byte for byte the mark
 *   `ideas mark -s shipped -n <url>` makes by hand, and the claim survives it.
 * - **closed unmerged → `accepted`**, the documented release: back on offer with
 *   its human sign-off intact.
 * - **detached → `accepted`**, likewise. See {@link IDEA_PR_OUTCOMES}.
 * - **open → nothing.**
 *
 * **A `shipped` entry is terminal here.** Its PR is observed like any other and
 * no outcome moves it, so re-opening or deleting the branch of a merged PR
 * cannot un-ship the work; it comes back under `unchanged` rather than dropped.
 *
 * `by` stamps the marks with the reconciling run's provenance, as
 * `ideas mark --thread` does; absent, each entry keeps its attribution.
 */
export function planIdeaPrTransitions(
  store: IdeasStore,
  observations: readonly IdeaPrObservation[],
  by?: WriteProvenance,
): IdeaPrPlan {
  const transitions: IdeaPrTransition[] = [];
  const unchanged: IdeaPrLink[] = [];
  const unobserved: IdeaPrLink[] = [];

  for (const link of ideaPrLinks(store)) {
    const seen = observations.find((o) => sameIdeaPr(o.pr, link.pr));
    if (!seen) {
      unobserved.push(link);
      continue;
    }
    const move = transitionFor(link, seen.outcome);
    if (!move) {
      unchanged.push(link);
      continue;
    }
    transitions.push(move);
  }

  const marks: IdeaMark[] = transitions.map((t) => {
    const mark: IdeaMark = { slug: t.slug, status: t.to };
    // Only `shipped` carries a note. A release writes none, leaving a rejection
    // reason the idea already carried untouched.
    if (t.to === 'shipped') mark.note = t.pr;
    if (by) mark.by = by;
    return mark;
  });

  return { transitions, marks, unchanged, unobserved };
}

/** The one move an outcome implies for a link, or null when it implies none. */
function transitionFor(link: IdeaPrLink, outcome: IdeaPrOutcome): IdeaPrTransition | null {
  // Only a `claimed` entry moves; `shipped` is terminal.
  if (link.status !== 'claimed') return null;
  const move = (to: IdeaStatus, why: string): IdeaPrTransition => ({
    slug: link.slug,
    pr: link.pr,
    from: link.status,
    to,
    outcome,
    why,
  });
  switch (outcome) {
    case 'merged':
      return move('shipped', `${link.pr} merged`);
    case 'closed':
      return move('accepted', `${link.pr} was closed without merging — the claim is released`);
    case 'detached':
      return move('accepted', `the head branch behind ${link.pr} is gone — the claim is released`);
    default:
      return null;
  }
}

/** Read untrusted input as PR observations, or throw with the first thing wrong. */
export function parseIdeaPrObservations<Candidate>(raw: Candidate): IdeaPrObservation[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('observations must be an array');

  return items.map((item, i) => {
    const where = `observations[${i}]`;
    const record = jsonObject(item);
    if (record === null) throw new Error(`${where} must be an object`);
    const pr = jsonText(record.pr);
    if (pr === null || !pr.trim()) throw new Error(`${where}.pr must be a non-empty PR url`);
    const outcome = record.outcome;
    if (!isIdeaPrOutcome(outcome)) throw new Error(`${where}.outcome must be one of ${IDEA_PR_OUTCOMES.join(', ')}`);
    return { pr: pr.trim(), outcome };
  });
}

/**
 * Read untrusted input (a CLI's `--json`, an HTTP body) as adds, or throw with
 * the first thing wrong. **The evidence rule is enforced here**, not left to the
 * caller: an idea citing nothing is the failure mode this whole store exists to
 * suppress, so it is a parse error rather than a lint. **The area is required on
 * the same footing**, so nothing new lands unfiled.
 *
 * Both {@link IDEA_COMMAND_AREA} containment rules are enforced here too, and
 * they are two rules rather than one:
 *
 * 1. A `command-gap` citation may appear only on an idea whose area *is*
 *    `commands` — anywhere else it is refused, whatever else the idea cites.
 * 2. It is the only source that may stand alone, so an idea citing nothing but
 *    `command-gap` is necessarily a `commands` idea — the one place the ledger
 *    accepts a citation with no locator at all.
 */
export function parseIdeaAdds<Candidate>(raw: Candidate): IdeaAdd[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('ideas must be an array');
  if (items.length === 0) throw new Error('ideas must not be empty');

  const seen = new Set<string>();
  return items.map((item, i) => {
    const where = `ideas[${i}]`;
    const record = jsonObject(item);
    if (record === null) throw new Error(`${where} must be an object`);
    const { slug, evidence, repo, area, status, note } = record;

    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    if (seen.has(slug)) throw new Error(`${where}.slug repeats ${slug} in the same batch`);
    seen.add(slug);
    const title = jsonText(record.title);
    if (title === null || !title.trim()) throw new Error(`${where}.title must be a non-empty string`);
    const rationale = jsonText(record.rationale);
    if (rationale === null || !rationale.trim()) throw new Error(`${where}.rationale must be a non-empty string`);
    if (!isIdeaRepo(repo))
      throw new Error(`${where}.repo must be a git remote slug like owner/name, never a checkout path`);
    if (!isIdeaArea(area))
      throw new Error(
        `${where}.area must be a kebab-case area (a-z, 0-9, single dashes) — any word will do, and these are the ones already in use: ${SEED_IDEA_AREAS.map((s) => s.area).join(', ')}`,
      );
    if (status !== undefined && !isIdeaStatus(status))
      throw new Error(`${where}.status must be one of ${IDEA_STATUSES.join(', ')}`);
    const noteText = jsonText(note);
    if (note !== undefined && noteText === null) throw new Error(`${where}.note must be a string`);

    const parsed = parseEvidenceList(evidence);
    if (parsed.length === 0) {
      throw new Error(
        `${where}.evidence must cite at least one of ${IDEA_EVIDENCE_SOURCES.join(', ')}, each with a path (or bucket + id for a judge note); only ${LOCATORLESS_SOURCE} stands alone`,
      );
    }
    if (area !== IDEA_COMMAND_AREA && parsed.some((e) => e.source === LOCATORLESS_SOURCE)) {
      throw new Error(
        `${where}.evidence cites ${LOCATORLESS_SOURCE}, which carries no locator and so is confined to the ${IDEA_COMMAND_AREA} area — this idea is filed under ${area}`,
      );
    }
    const add: IdeaAdd = {
      slug,
      title: title.trim(),
      rationale: rationale.trim(),
      evidence: parsed,
      repo,
      area,
    };
    if (isIdeaStatus(status)) add.status = status;
    if (noteText !== null) add.note = noteText;
    return add;
  });
}

/** Read untrusted input as marks, or throw with the first thing wrong. */
export function parseIdeaMarks<Candidate>(raw: Candidate): IdeaMark[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('marks must be an array');
  if (items.length === 0) throw new Error('marks must not be empty');

  return items.map((item, i) => {
    const where = `marks[${i}]`;
    const record = jsonObject(item);
    if (record === null) throw new Error(`${where} must be an object`);
    const { slug, status, note, by } = record;
    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    if (!isIdeaStatus(status)) throw new Error(`${where}.status must be one of ${IDEA_STATUSES.join(', ')}`);
    const noteText = jsonText(note);
    if (note !== undefined && noteText === null) throw new Error(`${where}.note must be a string`);
    // Optional, but a malformed one throws here rather than being dropped as at
    // the store's read boundary — this input has an author to tell.
    if (by !== undefined && parseWriteProvenance(by) === null)
      throw new Error(`${where}.by must carry a 16-hex-character thread id`);
    const actor = parseWriteProvenance(by);
    const mark: IdeaMark = { slug, status };
    if (noteText !== null) mark.note = noteText;
    if (actor) mark.by = actor;
    return mark;
  });
}

/** Which ideas to list. An absent field filters on nothing. */
export interface IdeaFilter {
  statuses?: readonly IdeaStatus[];
  /** A git remote slug. */
  repo?: string;
  /** An area. Matches exactly; a row with no area matches nothing. */
  area?: string;
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
    .filter((entry) => (filter.area ? entry.area === filter.area : true))
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
  // SAFETY: the entries come from `IDEA_STATUSES` itself, one per member and
  // nothing else, so every key of `IdeaStatus` is present — which is the part
  // `Object.fromEntries` cannot express, since it types its result on the tuple's
  // key type alone and so returns `Record<string, number>`.
  const counts = Object.fromEntries(IDEA_STATUSES.map((s) => [s, 0])) as Record<IdeaStatus, number>;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** Totals per area over the rows given, plus the rows carrying no area at all. */
export interface IdeaAreaCounts {
  /**
   * Area → how many rows are filed under it. **Every seed area is present, at 0
   * when empty**, so a tab strip renders the full vocabulary from this record
   * alone rather than scanning the ledger and then unioning in the seeds.
   */
  areas: Record<string, number>;
  /** Rows with no area — the legacy ones. Zero means the Unfiled tab is gone for good. */
  unfiled: number;
}

/** Totals per area over the rows given. */
export function countIdeaAreas(rows: readonly IdeaEntry[]): IdeaAreaCounts {
  const areas: Record<string, number> = Object.fromEntries(SEED_IDEA_AREAS.map((s) => [s.area, 0]));
  let unfiled = 0;
  for (const row of rows) {
    if (!row.area) {
      unfiled += 1;
      continue;
    }
    areas[row.area] = (areas[row.area] ?? 0) + 1;
  }
  return { areas, unfiled };
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

/**
 * Areas already in use that look like they might be `area`, strongest first.
 *
 * The sibling of {@link similarIdeaSlugs}, with the same restraint: **it never
 * refuses anything.** A free-text vocabulary fragments when one run writes `infra`
 * and the next `infrastructure`, and the fix is a reader noticing rather than a
 * gate, so `ideas add` reports these beside the entry it just recorded.
 *
 * Matches prefixes as well as shared tokens: the fragmentations worth catching are
 * abbreviations, which share no whole token with what they abbreviate.
 */
export function similarAreas(store: IdeasStore, area: string): string[] {
  const known = new Set<string>(SEED_IDEA_AREAS.map((s) => s.area));
  for (const entry of Object.values(store.ideas)) if (entry.area) known.add(entry.area);

  const tokens = new Set(area.split('-').filter((t) => t && !STOP_TOKENS.has(t)));
  const scored: { area: string; score: number }[] = [];
  for (const existing of known) {
    if (existing === area) continue;
    const other = existing.split('-').filter((t) => t && !STOP_TOKENS.has(t));
    const shared = other.filter((t) => tokens.has(t)).length;
    // An abbreviation shares no token with what it abbreviates, so a prefix of
    // three or more characters counts as a hit in its own right.
    const prefix = area.length >= 3 && existing.length >= 3 && (existing.startsWith(area) || area.startsWith(existing));
    if (shared === 0 && !prefix) continue;
    const overlap = tokens.size && other.length ? shared / Math.min(tokens.size, other.length) : 0;
    scored.push({ area: existing, score: Math.max(overlap, prefix ? 0.75 : 0) });
  }
  return scored
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.area.localeCompare(b.area))
    .map((s) => s.area);
}

/**
 * Where a citation points, in a form a reader can go and check. A
 * `command-gap` has nothing to locate and reads as the empty string.
 */
export function ideaCitation(evidence: IdeaEvidence): string {
  if (evidence.path) return evidence.path;
  if (evidence.bucket !== undefined) return `bucket ${evidence.bucket}/${evidence.id ?? ''}`;
  return '';
}

/**
 * The `/task` invocation that builds one idea, composed from what the ledger
 * already holds about it.
 *
 * **Derived, never stored.** There is deliberately no `prompt` field on
 * {@link IdeaEntry}: a stored copy would go stale against a re-file or a
 * rewritten comment, leaving the ledger holding two disagreeing statements of
 * the same task. The entry is the single source, so the dashboard and the CLI
 * emit the same bytes without coordinating.
 *
 * {@link IdeaEntry.comment} is the one part a person wrote *as build criteria*
 * and is quoted verbatim; editing the rendered prompt changes only that
 * reader's copy, while writing the comment changes it for everyone.
 *
 * The claim lines are on every prompt, not only an unclaimed one — a prompt is
 * pasted into a run that starts later, so what was free at render time may not
 * be, and `ideas claim` is what refuses.
 */
export function ideaTaskPrompt(entry: IdeaEntry): string {
  const lines: string[] = [
    `/task implement the "${entry.title}" idea from the ledger (slug: ${entry.slug}, area: ${ideaAreaLabel(entry.area)}, repo: ${entry.repo}).`,
    '',
    'Why it is worth building:',
    entry.rationale,
  ];

  if (entry.comment) {
    lines.push(
      '',
      'Build criteria a human wrote on the idea — these override the rationale where they disagree:',
      entry.comment,
    );
  }

  if (entry.evidence.length > 0) {
    lines.push('', 'What it cites, so you can check the premise before building on it:');
    for (const e of entry.evidence) {
      const where = ideaCitation(e);
      lines.push(
        `- ${e.source}${where ? ` ${where}` : ' (no locator — the gap is that the command was never written)'}${e.quote ? ` — "${e.quote}"` : ''}`,
      );
    }
  }

  lines.push(
    '',
    'Claim it on the ledger before you write anything, so a second run does not build it too, and attach the PR once it opens:',
    `  pnpm --filter ${CLAUDE_SERVER_PACKAGE} ideas claim --slug ${entry.slug} --by <your branch>`,
    `  pnpm --filter ${CLAUDE_SERVER_PACKAGE} ideas claim --slug ${entry.slug} --by <your branch> --pr <PR url>`,
  );

  return lines.join('\n');
}

/** One line of a bulleted rationale — its leading bold label, and the rest. */
export interface IdeaRationaleBullet {
  /** The `**What it is**` lead-in, without its asterisks. Absent when there is none. */
  label?: string;
  /** Everything after the label, or the whole bullet when it carries no label. */
  text: string;
}

/** `**Label** — rest`, `**Label**: rest`, or `**Label**` alone. */
const BULLET_LABEL = /^\*\*(.+?)\*\*\s*(?:[—–:-]\s*)?(.*)$/;

/** A bullet marker with a word after it. A dash alone is a sentence's punctuation. */
const BULLET_LINE = /^[-*•]\s+\S/;

/**
 * A rationale's bullets, or `[]` when it opens as a paragraph — the shape is read
 * from the text, since both are on the ledger at once.
 *
 * The bullets are the **leading run**: every line up to the first that is not a
 * bullet, so `/ideate`'s bullets still read as bullets when a paragraph of evidence
 * closes them. The first non-empty line must still be a bullet, so a paragraph
 * containing a dash stays prose rather than becoming a list with an orphan.
 *
 * A preview reading: the trailing prose is not in it, and the permalink renders the
 * rationale as markdown instead.
 */
export function ideaRationaleBullets(rationale: string): IdeaRationaleBullet[] {
  const filled = rationale
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const run: string[] = [];
  for (const line of filled) {
    if (!BULLET_LINE.test(line)) break;
    run.push(line);
  }

  return run.map((line) => {
    const body = line.replace(/^[-*•]\s+/, '').trim();
    const m = BULLET_LABEL.exec(body);
    if (!m?.[1]) return { text: body };
    const text = (m[2] ?? '').trim();
    return text ? { label: m[1].trim(), text } : { text: m[1].trim() };
  });
}
