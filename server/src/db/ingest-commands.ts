import { readFile, stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuditTokens,
  type CommandPattern,
  type CommandRun,
  type CommandRunStepStats,
  type CommandRunTurn,
  runKey,
  ZERO_WASTE,
} from '@claude-proxy/core';
import { commandStorePath, parseCommandRunStore } from '../command-runs.js';

/**
 * Index `logs/commands/runs.jsonl` into the `command_run` tree.
 *
 * The store is one file rather than a directory of many, so the watermark is a
 * single `file_watermark` row: `bytes` + `modified`, the same pair slice 2 keys
 * a transcript on. A store whose `stat` still matches is not even opened.
 *
 * A changed store is re-parsed whole and every row replaced: it is rotated and
 * truncated as well as appended to, and a run's record is rewritten wholesale
 * each time its transcript grows. Bounded — one row per run, not per line.
 */

/** The store's path relative to `logDir` — the `file_watermark` key. */
export const STORE_PATH = 'commands/runs.jsonl';

export interface CommandIngestStats {
  /** Runs the store holds, retired ones included. */
  runs: number;
  /** True when the store had changed and was re-parsed this pass. */
  parsed: boolean;
  /** Rows dropped because the store is no longer on disk. */
  deleted: number;
}

interface CommandStatements {
  insertRun: ReturnType<DatabaseSync['prepare']>;
  insertFlag: ReturnType<DatabaseSync['prepare']>;
  insertThread: ReturnType<DatabaseSync['prepare']>;
  insertTurn: ReturnType<DatabaseSync['prepare']>;
  insertStep: ReturnType<DatabaseSync['prepare']>;
  insertPattern: ReturnType<DatabaseSync['prepare']>;
  watermark: ReturnType<DatabaseSync['prepare']>;
}

function prepare(db: DatabaseSync): CommandStatements {
  return {
    insertRun: db.prepare(`
      INSERT INTO command_run (
        run_id, ord, command, args, prompt, command_hash, schema_version,
        model, started, ended, outcome, interruption, reached_end, retired,
        totals_input, totals_output, totals_cache_read, totals_cache_creation, totals_real_input,
        totals_cost, totals_turns, totals_tool_calls, totals_duration_ms, totals_wall_ms,
        meta_turns_unmapped, meta_nodes, meta_attributed, meta_anchored,
        updated_at, document
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertFlag: db.prepare('INSERT INTO command_run_flag (run_id, ord, flag) VALUES (?, ?, ?)'),
    insertThread: db.prepare('INSERT INTO command_run_thread (run_id, ord, member_thread_id) VALUES (?, ?, ?)'),
    insertTurn: db.prepare(`
      INSERT INTO command_run_turn (
        run_id, ord, file, timestamp, turn_thread_id, step, node,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_real_input,
        system_bytes, tools_bytes, tool_count, message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertStep: db.prepare(`
      INSERT INTO command_run_step (
        run_id, ord, step, title, reached, confidence,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_real_input,
        cost, turns, nodes, tool_calls,
        waste_errored_tools, waste_duplicate_reads, waste_retried_after_error,
        waste_no_op_turns, waste_cache_miss_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertPattern: db.prepare(`
      INSERT INTO command_run_pattern (run_id, ord, pattern_id, title, detail, step, node)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    watermark: db.prepare(`
      INSERT INTO file_watermark (path, bytes, modified, scanned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        bytes = excluded.bytes, modified = excluded.modified, scanned_at = excluded.scanned_at
    `),
  };
}

/** Every row the store contributes is replaced together; the children cascade. */
function clearRuns(db: DatabaseSync): number {
  const before = (db.prepare('SELECT count(*) c FROM command_run').get() as { c: number }).c;
  db.exec('DELETE FROM command_run');
  return before;
}

/** A record's tokens, defaulted the way `runTotals` defaults them. */
function tokensOf(value: unknown): AuditTokens {
  const t = value as Partial<AuditTokens> | undefined;
  return {
    input: t?.input ?? 0,
    output: t?.output ?? 0,
    cacheRead: t?.cacheRead ?? 0,
    cacheCreation: t?.cacheCreation ?? 0,
    realInput: t?.realInput ?? 0,
  };
}

/**
 * Write one record's row and its four child streams.
 *
 * Every field is read defensively and every child list defaults to empty:
 * `readCommandRuns` keeps records from a writer this code does not know. A field
 * such a record lacks becomes a column default here, while `document` keeps the
 * record itself intact.
 */
function writeRun(st: CommandStatements, run: CommandRun, ord: number): void {
  // The record's key, not its thread: a nested run shares its host's thread id,
  // so keying on that would collide on the second run of a transcript.
  const id = runKey(run);
  const totals = run.totals ?? undefined;
  const tokens = tokensOf(totals?.tokens);
  const meta = run.meta ?? undefined;

  st.insertRun.run(
    id,
    ord,
    run.command,
    run.args ?? null,
    run.prompt ?? null,
    run.commandHash ?? null,
    run.schema,
    run.model ?? null,
    run.started ?? null,
    run.ended ?? null,
    run.outcome ?? null,
    run.interruption ?? null,
    run.reachedEnd ? 1 : 0,
    run.retired ? 1 : 0,
    tokens.input,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheCreation,
    tokens.realInput,
    totals?.cost ?? 0,
    totals?.turns ?? 0,
    totals?.toolCalls ?? 0,
    totals?.durationMs ?? 0,
    totals?.wallMs ?? 0,
    meta?.turnsUnmapped ?? 0,
    meta?.nodes ?? 0,
    meta?.attributed ?? 0,
    meta?.anchored ?? 0,
    run.updatedAt ?? null,
    // Re-serialized rather than the raw line: `JSON.stringify` preserves the key
    // order `JSON.parse` produced, so re-parsing matches the file reader's object.
    JSON.stringify(run),
  );

  (run.flags ?? []).forEach((flag, i) => {
    st.insertFlag.run(id, i, flag);
  });
  (run.threadIds ?? []).forEach((member, i) => {
    st.insertThread.run(id, i, member);
  });

  (run.turns ?? []).forEach((turn: CommandRunTurn, i) => {
    const t = tokensOf(turn.tokens);
    st.insertTurn.run(
      id,
      i,
      turn.file,
      turn.timestamp ?? null,
      turn.threadId ?? null,
      turn.step ?? null,
      turn.node ?? null,
      t.input,
      t.output,
      t.cacheRead,
      t.cacheCreation,
      t.realInput,
      turn.systemBytes ?? 0,
      turn.toolsBytes ?? 0,
      turn.toolCount ?? 0,
      turn.messageCount ?? 0,
    );
  });

  (run.stepStats ?? []).forEach((step: CommandRunStepStats, i) => {
    const t = tokensOf(step.tokens);
    const waste = { ...ZERO_WASTE, ...(step.waste ?? {}) };
    st.insertStep.run(
      id,
      i,
      step.step ?? null,
      step.title ?? null,
      step.reached ? 1 : 0,
      step.confidence ?? null,
      t.input,
      t.output,
      t.cacheRead,
      t.cacheCreation,
      t.realInput,
      step.cost ?? 0,
      step.turns ?? 0,
      step.nodes ?? 0,
      step.toolCalls ?? 0,
      waste.erroredTools,
      waste.duplicateReads,
      waste.retriedAfterError,
      waste.noOpTurns,
      waste.cacheMissTokens,
    );
  });

  (run.patterns ?? []).forEach((pattern: CommandPattern, i) => {
    st.insertPattern.run(
      id,
      i,
      pattern.id,
      pattern.title ?? null,
      pattern.detail ?? null,
      pattern.step ?? null,
      pattern.node ?? null,
    );
  });
}

/**
 * Bring the command tables level with `logs/commands/runs.jsonl`. Safe to call
 * repeatedly: an unchanged store is skipped on its watermark, and the rebuild
 * runs in one transaction, so a part-way failure leaves the previous view intact
 * rather than a half-replaced one.
 */
export async function ingestCommandRuns(db: DatabaseSync, logDir: string): Promise<CommandIngestStats> {
  const stats: CommandIngestStats = { runs: 0, parsed: false, deleted: 0 };
  const file = commandStorePath(logDir);

  let bytes: number;
  let modified: string;
  try {
    const info = await stat(file);
    bytes = info.size;
    modified = info.mtime.toISOString();
  } catch (err) {
    // Only a *missing* store means the rows are unbacked. Any other error says
    // nothing about what is on disk, so it must not drop the tables.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    db.exec('BEGIN');
    try {
      stats.deleted = clearRuns(db);
      db.prepare('DELETE FROM file_watermark WHERE path = ?').run(STORE_PATH);
      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }
    return stats;
  }

  const mark = db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(STORE_PATH) as
    | { bytes: number; modified: string }
    | undefined;
  if (mark && mark.bytes === bytes && mark.modified === modified) {
    stats.runs = (db.prepare('SELECT count(*) c FROM command_run').get() as { c: number }).c;
    return stats;
  }

  // Parsed through the store's own reader, so the two sides cannot drift.
  const runs = parseCommandRunStore(await readFile(file, 'utf8'));
  const st = prepare(db);

  db.exec('BEGIN');
  try {
    clearRuns(db);
    runs.forEach((run, ord) => {
      writeRun(st, run, ord);
    });
    st.watermark.run(STORE_PATH, bytes, modified, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  stats.runs = runs.length;
  stats.parsed = true;
  return stats;
}
