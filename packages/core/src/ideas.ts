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
 */
export const IDEA_STATUSES = ['proposed', 'accepted', 'rejected', 'shipped'] as const;

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
    const { title, rationale, evidence, repo, status, created, updated, note } = value as Record<string, unknown>;
    if (!isIdeaStatus(status)) continue;
    if (!isIdeaRepo(repo)) continue;
    if (typeof title !== 'string' || !title.trim()) continue;
    const kept = parseEvidenceList(evidence);
    // An entry that cites nothing is not a weaker entry, it is the thing the
    // evidence rule exists to keep out of the file.
    if (kept.length === 0) continue;
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
    };
  }
  return store;
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
    next.ideas[mark.slug] = {
      ...current,
      status: mark.status,
      updated: at,
      ...(note ? { note } : {}),
    };
    updated.push(mark.slug);
  }
  return { store: next, updated, unknown };
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
    const { slug, status, note } = item as Record<string, unknown>;
    if (!isIdeaSlug(slug)) throw new Error(`${where}.slug must be kebab-case (a-z, 0-9, single dashes)`);
    if (!isIdeaStatus(status)) throw new Error(`${where}.status must be one of ${IDEA_STATUSES.join(', ')}`);
    if (note !== undefined && typeof note !== 'string') throw new Error(`${where}.note must be a string`);
    return { slug: slug as string, status, ...(note === undefined ? {} : { note }) };
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
