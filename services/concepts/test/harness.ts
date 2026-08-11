import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, DbStatement, DbValue } from '../src/db.ts';

/**
 * `node:sqlite` is required at runtime rather than imported, as in
 * `server/src/db/open.ts`: it is newer than the builtin list Vite ships, so a
 * static import makes Vitest try to resolve a package called `sqlite` and fail.
 */
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
  for (const migration of ['0001_init.sql', '0002_ideas.sql']) {
    database.exec(readFileSync(join(HERE, '..', 'migrations', migration), 'utf8'));
  }
  return {
    async all<T>(sql: string, params: DbValue[] = []): Promise<T[]> {
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

/** A concept with sensible defaults, so a test only states what it is about. */
export function concept(overrides: Record<string, unknown> = {}) {
  return {
    term: 'Backpressure',
    sentence: 'A consumer telling a producer to slow down.',
    field: 'distributed systems',
    skills: ['systems-design'],
    savedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}
