/**
 * Concepts — what `/teach` writes down.
 *
 * A `/teach` run ends by appending one record to `logs/concepts.jsonl`: the term
 * that was looked up, the one Simplified Technical English sentence to say it
 * back with, the field the term belongs to, which skills were consulted, and —
 * for runs recent enough to write them — the research, tips and sources behind
 * the answer. The file is append-only, one JSON object per line, and it is the
 * sole source of truth: the `concept` table is rebuilt from it wholesale. Every
 * field added after the first record is optional.
 */

import { type JsonValue, jsonObject, jsonText, jsonValueOf } from './json.js';

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

  /* --- The detail fields --- *
   * Every record written before they existed omits them, so an unrecorded field
   * stays *absent* rather than becoming an empty value. */

  /** The research the run did, as prose. */
  notes?: string;
  /** Practical guidance, one entry per tip. */
  tips?: string[];
  /** Where the term was pinned down — URLs, skills, references. */
  sources?: string[];
  /**
   * Public skills the run's `find-skills` step turned up, as against
   * {@link Concept.skills}, which were consulted to name the term.
   */
  surfacedSkills?: string[];
}

/**
 * A concept together with its line in the store.
 *
 * The store has no key — nothing retracts a line and the same term may be saved
 * twice — so a record's identity is its index in file order. That is what a
 * detail route addresses a concept by.
 */
export interface StoredConcept extends Concept {
  ord: number;
}

/**
 * Skills that name a step of the `/teach` run rather than the term's field.
 *
 * `find-skills` is the skill that step invokes, so it describes the machinery
 * and never the concept. Filtered where concepts are read for display; the store
 * keeps whatever was written.
 */
export const META_SKILLS: readonly string[] = ['find-skills'];

/** A skill list with the meta-skills dropped. Order is otherwise preserved. */
export function withoutMetaSkills(skills: readonly string[] | undefined): string[] {
  return (skills ?? []).filter((skill) => !META_SKILLS.includes(skill));
}

/**
 * Structural guard for a line read back off the store. Checks only the two
 * fields that make a record identifiable — a record from a writer this code does
 * not know is kept and rendered from what it has, rather than emptying the page.
 * Callers read the rest defensively, which is what {@link normalizeConcept} is for.
 */
export function isConcept<Candidate>(value: Candidate): value is Candidate & Concept {
  const record = jsonObject(jsonValueOf(value));
  return record !== null && jsonText(record.term) !== null && jsonText(record.savedAt) !== null;
}

/** A string array, or `undefined` when the field was never recorded at all. */
function optionalList(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => jsonText(entry)).filter((entry): entry is string => entry !== null);
}

/**
 * A record with every *required* field defaulted, so a listing never has to
 * guard per cell. Non-string entries in `skills` are dropped; a missing `field`
 * or `sentence` becomes the empty string.
 *
 * The detail fields go the other way: an absent one is left off the result
 * rather than defaulted, because "not recorded" and "recorded empty" are
 * different facts. That also keeps `document` a faithful round-trip for records
 * written before those fields existed.
 */
export function normalizeConcept(concept: Concept): Concept {
  const skills = Array.isArray(concept.skills) ? concept.skills.filter((s) => jsonText(s) !== null) : [];
  const out: Concept = {
    term: concept.term,
    sentence: jsonText(concept.sentence) ?? '',
    field: jsonText(concept.field) ?? '',
    skills,
    savedAt: concept.savedAt,
  };

  const notes = jsonText(concept.notes);
  if (notes !== null) out.notes = notes;
  const tips = optionalList(concept.tips);
  if (tips) out.tips = tips;
  const sources = optionalList(concept.sources);
  if (sources) out.sources = sources;
  const surfaced = optionalList(concept.surfacedSkills);
  if (surfaced) out.surfacedSkills = surfaced;

  return out;
}

/** Newest first. Stable, so records saved in the same millisecond keep store order. */
export function sortConcepts<T extends Concept>(concepts: T[]): T[] {
  return concepts.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
}
