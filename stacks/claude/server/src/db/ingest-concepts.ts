import { readFile, stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Concept } from '@agent-proxy/claude-core';
import { conceptStorePath, parseConceptStore } from '../concepts.js';

/**
 * Index `logs/concepts.jsonl` into the `concept` table.
 *
 * The store is one file rather than a directory of many, so the watermark is a
 * single `file_watermark` row: `bytes` + `modified`, the same pair the command
 * store keys on. A store whose `stat` still matches is not even opened.
 *
 * A changed store is re-parsed whole and every row replaced. The file is only
 * ever appended to, so a diff would be possible — but the table is small (one
 * row per `/teach` run), and a wholesale rebuild is what keeps
 * `rm logs/claude-proxy.db && ingest` a total recovery rather than a resync.
 */

/** The store's path relative to `logDir` — the `file_watermark` key. */
export const STORE_PATH = 'concepts.jsonl';

export interface ConceptIngestStats {
  /** Concepts the store holds. */
  concepts: number;
  /** True when the store had changed and was re-parsed this pass. */
  parsed: boolean;
  /** Rows dropped because the store is no longer on disk. */
  deleted: number;
}

interface ConceptStatements {
  insertConcept: ReturnType<DatabaseSync['prepare']>;
  insertSkill: ReturnType<DatabaseSync['prepare']>;
  insertItem: ReturnType<DatabaseSync['prepare']>;
  watermark: ReturnType<DatabaseSync['prepare']>;
}

function prepare(db: DatabaseSync): ConceptStatements {
  return {
    insertConcept: db.prepare(
      'INSERT INTO concept (ord, term, sentence, field, saved_at, notes, document) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    insertSkill: db.prepare('INSERT INTO concept_skill (ord, skill_ord, skill) VALUES (?, ?, ?)'),
    insertItem: db.prepare('INSERT INTO concept_item (ord, kind, item_ord, item) VALUES (?, ?, ?, ?)'),
    watermark: db.prepare(`
      INSERT INTO file_watermark (path, bytes, modified, scanned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        bytes = excluded.bytes, modified = excluded.modified, scanned_at = excluded.scanned_at
    `),
  };
}

/** True when a failed `stat` says the file is not there; any other errno must rethrow. */
function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** Every row the store contributes is replaced together; the skills cascade. */
function clearConcepts(db: DatabaseSync): number {
  // SAFETY: `count(*)` aliased to `c` is the whole select list, and an aggregate with
  // no GROUP BY always answers exactly one row.
  const before = (db.prepare('SELECT count(*) c FROM concept').get() as { c: number }).c;
  db.exec('DELETE FROM concept');
  return before;
}

/**
 * Write one record's row, its skill list, and whichever detail lists it carries.
 *
 * An absent detail list contributes no rows. `concept_item` does not distinguish
 * a list that was empty from one that was never recorded; the page reads that
 * distinction off `document`.
 */
function writeConcept(st: ConceptStatements, concept: Concept, ord: number): void {
  st.insertConcept.run(
    ord,
    concept.term,
    concept.sentence,
    concept.field,
    concept.savedAt,
    concept.notes ?? '',
    // Re-serialized rather than the raw line: `JSON.stringify` preserves the key
    // order `JSON.parse` produced, so re-parsing matches the file reader's object.
    JSON.stringify(concept),
  );
  concept.skills.forEach((skill, i) => {
    st.insertSkill.run(ord, i, skill);
  });
  writeItems(st, ord, 'tip', concept.tips);
  writeItems(st, ord, 'source', concept.sources);
  writeItems(st, ord, 'surfaced_skill', concept.surfacedSkills);
}

/** One `concept_item` row per entry, in the order the record listed them. */
function writeItems(st: ConceptStatements, ord: number, kind: string, items: string[] | undefined): void {
  (items ?? []).forEach((item, i) => {
    st.insertItem.run(ord, kind, i, item);
  });
}

/**
 * Bring the concept table level with `logs/concepts.jsonl`. Safe to call
 * repeatedly: an unchanged store is skipped on its watermark, and the rebuild
 * runs in one transaction, so a part-way failure leaves the previous view intact
 * rather than a half-replaced one.
 */
export async function ingestConcepts(db: DatabaseSync, logDir: string): Promise<ConceptIngestStats> {
  const stats: ConceptIngestStats = { concepts: 0, parsed: false, deleted: 0 };
  const file = conceptStorePath(logDir);

  let bytes: number;
  let modified: string;
  try {
    const info = await stat(file);
    bytes = info.size;
    modified = info.mtime.toISOString();
  } catch (cause) {
    // Only a *missing* store means the rows are unbacked. Any other error says
    // nothing about what is on disk, so it must not drop the table.
    if (!isMissingFile(cause)) throw cause;
    db.exec('BEGIN');
    try {
      stats.deleted = clearConcepts(db);
      db.prepare('DELETE FROM file_watermark WHERE path = ?').run(STORE_PATH);
      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }
    return stats;
  }

  // SAFETY: this SELECT names exactly `bytes` and `modified`, and `path` is the
  // table's primary key, so the answer is one row or none.
  const mark = db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(STORE_PATH) as
    | { bytes: number; modified: string }
    | undefined;
  if (mark && mark.bytes === bytes && mark.modified === modified) {
    // SAFETY: `count(*)` aliased to `c` is the whole select list, and an aggregate with
    // no GROUP BY always answers exactly one row.
    stats.concepts = (db.prepare('SELECT count(*) c FROM concept').get() as { c: number }).c;
    return stats;
  }

  // Parsed through the store's own reader, so the two sides cannot drift.
  const concepts = parseConceptStore(await readFile(file, 'utf8'));
  const st = prepare(db);

  db.exec('BEGIN');
  try {
    clearConcepts(db);
    concepts.forEach((concept, ord) => {
      writeConcept(st, concept, ord);
    });
    st.watermark.run(STORE_PATH, bytes, modified, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  stats.concepts = concepts.length;
  stats.parsed = true;
  return stats;
}
