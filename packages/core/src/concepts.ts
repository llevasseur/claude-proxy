/**
 * Concepts — what `/teach` writes down.
 *
 * A `/teach` run ends by appending one record to `logs/concepts.jsonl`: the term
 * that was looked up, the one Simplified Technical English sentence to say it
 * back with, the field the term belongs to, and which skills were consulted.
 * The file is append-only, one JSON object per line, and it is the sole source
 * of truth — the `concept` table is rebuilt from it wholesale.
 */

/** One term `/teach` recorded, as stored on a line of `logs/concepts.jsonl`. */
export interface Concept {
  /** The term that was learned. */
  term: string;
  /** The single Simplified Technical English sentence to say the term back with. */
  sentence: string;
  /** The domain the term belongs to, as the run judged it. */
  field: string;
  /** Skills consulted while pinning the term down. */
  skills: string[];
  /** When the record was appended, ISO 8601. */
  savedAt: string;
}

/**
 * Structural guard for a line read back off the store. Checks only the two
 * fields that make a record identifiable — a record from a writer this code does
 * not know is kept and rendered from what it has, rather than emptying the page.
 * Callers read the rest defensively, which is what {@link normalizeConcept} is for.
 */
export function isConcept(value: unknown): value is Concept {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.term === "string" && typeof v.savedAt === "string";
}

/**
 * A record with every optional field defaulted, so a listing never has to guard
 * per cell. Non-string entries in `skills` are dropped; a missing `field` or
 * `sentence` becomes the empty string.
 */
export function normalizeConcept(concept: Concept): Concept {
  const skills = Array.isArray(concept.skills) ? concept.skills.filter((s): s is string => typeof s === "string") : [];
  return {
    term: concept.term,
    sentence: typeof concept.sentence === "string" ? concept.sentence : "",
    field: typeof concept.field === "string" ? concept.field : "",
    skills,
    savedAt: concept.savedAt,
  };
}

/** Newest first. Stable, so records saved in the same millisecond keep store order. */
export function sortConcepts(concepts: Concept[]): Concept[] {
  return concepts.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
}
