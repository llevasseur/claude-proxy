import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import type { Db, DbStatement, DbValue } from '../src/db.ts';
import type { Env } from '../src/env.ts';
import {
  arrayField,
  isJsonNumber,
  isJsonRecord,
  isJsonText,
  type JsonRecord,
  type JsonValue,
  parseJson,
  recordField,
} from '../src/json.ts';

/**
 * `node:sqlite` is required at runtime rather than imported, as in
 * `server/src/db/open.ts`: it is newer than the builtin list Vite ships, so a
 * static import makes Vitest try to resolve a package called `sqlite` and fail.
 */
// SAFETY: `createRequire` is typed to return `any` because a specifier is
// normally a variable; here it is the string literal `'node:sqlite'`, so the
// module object really is the one `typeof import('node:sqlite')` describes, and
// a Node without that builtin throws on this line rather than reaching a caller.
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A `Db` backed by in-memory `node:sqlite`. D1 is SQLite, so this runs the
 * production SQL — FTS5 virtual table and `bm25()` included — on the same
 * engine the Worker will hit.
 */
export function testDb(): Db {
  const database = new sqlite.DatabaseSync(':memory:');
  // Every migration, in order — the same files `wrangler d1 migrations apply`
  // runs, so a schema the suite accepts is a schema D1 accepts.
  for (const migration of ['0001_init.sql', '0002_ideas.sql', '0003_notes.sql']) {
    database.exec(readFileSync(join(HERE, '..', 'migrations', migration), 'utf8'));
  }
  return {
    async all<T>(sql: string, params: DbValue[] = []): Promise<T[]> {
      // SAFETY: `T` is named by the caller's own SELECT list, and `node:sqlite`
      // hands back exactly the columns that SELECT projected. This is the same
      // unchecked step D1 takes in `Db`'s production implementation — the point
      // of this harness is that both sides make it identically.
      return database.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: DbValue[] = []): Promise<{ changes: number }> {
      return { changes: Number(database.prepare(sql).run(...params).changes) };
    },
    async batch(statements: DbStatement[]): Promise<void> {
      database.exec('BEGIN');
      try {
        for (const statement of statements) database.prepare(statement.sql).run(...statement.params);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/** The fields of a `/teach` record a test ever varies. Everything else is the default. */
export interface ConceptOverrides {
  term?: string;
  sentence?: string;
  field?: string;
  skills?: string[];
  savedAt?: string;
  notes?: string;
  tips?: string[];
  sources?: string[];
}

/**
 * A concept with sensible defaults, so a test only states what it is about.
 *
 * The result is a `JsonRecord` rather than a domain type on purpose: `saveConcept`
 * is the boundary that decides what a concept is, and a test that handed it an
 * already-valid `Concept` could not exercise that decision.
 */
export function concept(overrides: ConceptOverrides = {}): JsonRecord {
  const record: JsonRecord = {
    term: 'Backpressure',
    sentence: 'A consumer telling a producer to slow down.',
    field: 'distributed systems',
    skills: ['systems-design'],
    savedAt: '2026-08-01T10:00:00.000Z',
  };
  // An absent override leaves the default standing; the tests that assert a field
  // is *missing* pass no key at all rather than an explicit `undefined`.
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) record[key] = value;
  }
  return record;
}

/**
 * The Worker's bindings for a case that never reaches D1 — every one of them is
 * answered by auth, or by the `Db` the test injects directly.
 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  // SAFETY: nothing in these tests calls a method on the D1 binding — auth
  // rejects before `env.operator_db` is read, and `runBackup` takes its `Db`
  // as a separate argument — so this placeholder is only ever carried, and a
  // path that did touch it would throw rather than silently read a stub row.
  const database = {} as D1Database;
  return { operator_db: database, CONCEPTS_TOKEN: 'secret', ...overrides };
}

/**
 * Reads a JSON body once, instead of asserting it into shape at every call site.
 *
 * Each reader below narrows with the Worker's own guards from `src/json.ts` and
 * **throws** when the shape is wrong: a handler that stops returning the field a
 * test names must fail that test, where a silent `undefined` would let the
 * assertion around it quietly pass.
 */
export async function bodyRecord(response: Response): Promise<JsonRecord> {
  return textRecord(await response.text());
}

/** The same reading for JSON a test already holds as text — an export, a backup blob. */
export function textRecord(text: string): JsonRecord {
  const parsed = parseJson(text);
  if (!isJsonRecord(parsed)) throw new Error(`expected a JSON object, got: ${text.slice(0, 200)}`);
  return parsed;
}

export function recordAt(source: JsonRecord, key: string): JsonRecord {
  const value = recordField(source, key);
  if (value === undefined) throw new Error(`\`${key}\` is not an object: ${JSON.stringify(source[key])}`);
  return value;
}

export function arrayAt(source: JsonRecord, key: string): JsonValue[] {
  const value = arrayField(source, key);
  if (value === undefined) throw new Error(`\`${key}\` is not an array: ${JSON.stringify(source[key])}`);
  return value;
}

export function recordsAt(source: JsonRecord, key: string): JsonRecord[] {
  return arrayAt(source, key).map((entry, index) => {
    if (!isJsonRecord(entry)) throw new Error(`\`${key}[${index}]\` is not an object: ${JSON.stringify(entry)}`);
    return entry;
  });
}

/** Accepts `''`, which several note cases assert on, so this cannot use `textField`. */
export function textAt(source: JsonRecord, key: string): string {
  const value = source[key];
  if (!isJsonText(value)) throw new Error(`\`${key}\` is not a string: ${JSON.stringify(value)}`);
  return value;
}

export function numberAt(source: JsonRecord, key: string): number {
  const value = source[key];
  if (!isJsonNumber(value)) throw new Error(`\`${key}\` is not a number: ${JSON.stringify(value)}`);
  return value;
}
