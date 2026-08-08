/**
 * The database port.
 *
 * `store.ts` is written against this rather than against `D1Database` so the
 * exact SQL that runs at the edge also runs under `node:sqlite` in the tests.
 * D1 *is* SQLite, so this is not a mock standing in for the real thing — it is
 * the same engine reached through a different handle, and a query that passes
 * the suite is a query D1 will accept.
 */

import type { D1Database } from '@cloudflare/workers-types';

export type DbValue = string | number | null;

export interface DbStatement {
  sql: string;
  params: DbValue[];
}

export interface Db {
  all<T>(sql: string, params?: DbValue[]): Promise<T[]>;
  /** Runs every statement, atomically where the driver can. */
  batch(statements: DbStatement[]): Promise<void>;
}

export function d1Db(database: D1Database): Db {
  return {
    async all<T>(sql: string, params: DbValue[] = []): Promise<T[]> {
      const result = await database
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return result.results;
    },
    async batch(statements: DbStatement[]): Promise<void> {
      if (statements.length === 0) return;
      await database.batch(statements.map((s) => database.prepare(s.sql).bind(...s.params)));
    },
  };
}
