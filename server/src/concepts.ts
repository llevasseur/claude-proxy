/**
 * The concept store — the file `/teach` appends to, and the reader over it.
 *
 * `/teach` ends a run by appending one JSON record per line to
 * `logs/concepts.jsonl`. Nothing rewrites or retracts a line: unlike the command
 * store there is no key and no supersede, so every line the file holds is a
 * concept that was saved, in the order it was saved.
 *
 * That file is the source of truth. The `concept` table is a disposable view
 * over it — see `server/src/db/ingest-concepts.ts`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { isConcept, normalizeConcept, sortConcepts, type Concept, type StoredConcept } from "@claude-proxy/core";

/** The append-only concept store. */
export function conceptStorePath(logDir: string): string {
  return path.join(logDir, "concepts.jsonl");
}

/**
 * The store's text as records, **in file order**.
 *
 * Tolerant on every line, because the file is append-only and long-lived: a line
 * that will not parse is skipped — a torn final line from an interrupted append
 * is the normal case — and a record from a writer this code does not know is
 * kept, normalized to what it has.
 */
export function parseConceptStore(text: string): Concept[] {
  const out: Concept[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isConcept(parsed)) continue;
    out.push(normalizeConcept(parsed));
  }
  return out;
}

/**
 * Every concept the store holds, newest first, each carrying the line it sits on.
 *
 * `ord` is assigned from file order *before* the sort, so it keeps meaning the
 * position in the file rather than the position on the page — that is what makes
 * it a stable address for a detail route. A missing store reads as empty: a
 * device where `/teach` has never run is an empty page, not an error.
 */
export async function readConcepts(logDir: string): Promise<StoredConcept[]> {
  let text: string;
  try {
    text = await readFile(conceptStorePath(logDir), "utf8");
  } catch {
    return [];
  }
  return sortConcepts(parseConceptStore(text).map((concept, ord) => ({ ...concept, ord })));
}
