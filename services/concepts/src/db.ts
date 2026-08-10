/**
 * The database port. `store.ts` targets this rather than `D1Database` so the
 * same SQL also runs under `node:sqlite` in the tests — D1 is SQLite, so the
 * suite exercises the real engine rather than a mock.
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
  /**
   * One statement, reporting how many rows it changed.
   *
   * `batch` cannot answer that, and the count is the whole point at exactly one
   * call site: the conditional claim in `ideas.ts` decides who won a race by
   * whether its `UPDATE` matched. See ADR 0006.
   */
  run(sql: string, params?: DbValue[]): Promise<{ changes: number }>;
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
    async run(sql: string, params: DbValue[] = []): Promise<{ changes: number }> {
      const result = await database
        .prepare(sql)
        .bind(...params)
        .run();
      // D1 reports it as `meta.changes`; a driver that omits it reads as 0,
      // which fails the claim closed rather than handing it to both runs.
      return { changes: Number(result.meta?.changes ?? 0) };
    },
    async batch(statements: DbStatement[]): Promise<void> {
      if (statements.length === 0) return;
      await database.batch(statements.map((s) => database.prepare(s.sql).bind(...s.params)));
    },
  };
}
