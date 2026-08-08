import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * `node:sqlite` is required at runtime, not imported: it is newer than the
 * builtin list Vite ships, so a static import makes Vitest try to resolve a
 * package called `sqlite` and fail. The `import type` above is erased before any
 * bundler sees it.
 */
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * The SQLite query substrate: a **disposable materialized view** over `logs/`.
 *
 * `logs/` stays the sole source of truth. Every table here is reconstructible by
 * re-ingesting the sidecars, so total recovery is
 * `rm logs/claude-proxy.db && pnpm --filter server ingest`.
 *
 * Nothing authored lives here. `logs/suggestion-status.json` and the device
 * settings file stay JSON on disk because they are not derivable from the logs,
 * and a disposable view may not hold the only copy of anything.
 *
 * See `docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md`.
 */

/** `<logDir>/claude-proxy.db`. `logs/` is gitignored, so the view ships with the logs it mirrors. */
export function resolveDbPath(logDir: string): string {
  return path.join(logDir, 'claude-proxy.db');
}

/**
 * Schema version, tracked in `PRAGMA user_version`. Bump it and add a migration
 * step below when the shape changes, so an existing file survives a `git pull`.
 */
export const SCHEMA_VERSION = 12;

/**
 * Slice 1 — audit rows only. The `.md` and `.request.txt` bodies stay on disk;
 * the DB stores pointers.
 *
 * `md_path` / `request_path` are nullable and paired with `blob_evicted`, making
 * "retention deleted the body but the metrics survived" a queryable state rather
 * than a dangling path.
 *
 * `source_dir` is `''` for the live log directory and `archive/<YYYY-MM-DD>` for
 * an archived day, relative to `logDir`. It lets a read reproduce `readSidecars`
 * and `readArchivedDay` exactly.
 *
 * The `*_present` flags keep absent and all-null distinct: a legacy sidecar has
 * no `session` object, while a current one can carry a session whose every field
 * is null.
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS request (
  id                      TEXT PRIMARY KEY,
  source_dir              TEXT NOT NULL,
  timestamp               TEXT NOT NULL,
  model                   TEXT NOT NULL,
  endpoint                TEXT,
  status_code             INTEGER,
  session_present         INTEGER NOT NULL DEFAULT 0,
  session_id              TEXT,
  app                     TEXT,
  user_agent              TEXT,
  account                 TEXT,
  metadata_session_id     TEXT,
  device_id               TEXT,
  tokens_input            INTEGER NOT NULL,
  tokens_output           INTEGER NOT NULL,
  tokens_cache_read       INTEGER NOT NULL,
  tokens_cache_creation   INTEGER NOT NULL,
  tokens_real_input       INTEGER NOT NULL,
  req_tool_count          INTEGER NOT NULL,
  req_tools_bytes         INTEGER NOT NULL,
  req_system_bytes        INTEGER NOT NULL,
  req_total_bytes         INTEGER NOT NULL,
  skim_present            INTEGER NOT NULL DEFAULT 0,
  skim_enabled            INTEGER,
  skim_served_from_cache  INTEGER,
  skim_saved_input_tokens INTEGER,
  skim_cache_key          TEXT,
  rate_limit_present      INTEGER NOT NULL DEFAULT 0,
  md_path                 TEXT,
  request_path            TEXT,
  blob_evicted            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS request_timestamp_idx  ON request(timestamp);
CREATE INDEX IF NOT EXISTS request_model_idx      ON request(model);
CREATE INDEX IF NOT EXISTS request_session_idx    ON request(session_id);
CREATE INDEX IF NOT EXISTS request_source_dir_idx ON request(source_dir);

-- The headline capability unlock: "which tools burn the most tokens across every
-- session" stops being a full readdir and becomes a GROUP BY.
CREATE TABLE IF NOT EXISTS request_tool (
  request_id TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  name       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  est_tokens INTEGER NOT NULL,
  PRIMARY KEY (request_id, ord)
);

CREATE INDEX IF NOT EXISTS request_tool_name_idx ON request_tool(name);

CREATE TABLE IF NOT EXISTS request_rate_limit (
  request_id   TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  header_name  TEXT NOT NULL,
  header_value TEXT NOT NULL,
  PRIMARY KEY (request_id, ord)
);

-- Files on disk that are not usable audit rows. They are still counted: the
-- file-backed readers tally an unparseable file under parseErrors and a
-- structurally invalid one under the digest's skipped count.
CREATE TABLE IF NOT EXISTS request_skipped (
  id         TEXT PRIMARY KEY,
  source_dir TEXT NOT NULL,
  reason     TEXT NOT NULL,
  timestamp  TEXT
);

CREATE INDEX IF NOT EXISTS request_skipped_source_dir_idx ON request_skipped(source_dir);

-- Ingest progress, one row per scanned directory. An archived day whose listing
-- still matches its watermark is skipped wholesale on the next run.
CREATE TABLE IF NOT EXISTS ingest_watermark (
  source_dir TEXT PRIMARY KEY,
  last_stem  TEXT,
  files_seen INTEGER NOT NULL,
  scanned_at TEXT NOT NULL
);
`;

/**
 * Slice 2 — session transcripts. One row per `logs/sessions/<threadId>.md`,
 * carrying the header metadata `parseSessionTranscript` derives, the listing's
 * `bytes` / `modified`, and the opening prompt off the `.state.json` sidecar.
 *
 * The transcript body stays on disk and `md_path` points at it. Eviction is not
 * a separate state here as it is for `request`: a body that goes away takes the
 * row with it on the next pass.
 *
 * `bytes` and `modified` double as the per-file watermark — a transcript is
 * mutable, so "seen this stem already" is not enough to skip it.
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS session (
  thread_id     TEXT PRIMARY KEY,
  model         TEXT,
  session_id    TEXT,
  started       TEXT,
  tasks         INTEGER NOT NULL,
  decisions     INTEGER NOT NULL,
  tools         INTEGER NOT NULL,
  errors        INTEGER NOT NULL,
  first_task    TEXT,
  title         TEXT,
  subtitle      TEXT,
  derived_title TEXT,
  bytes         INTEGER NOT NULL,
  modified      TEXT NOT NULL,
  md_path       TEXT,
  -- The untruncated opening prompt from <threadId>.state.json, null when the
  -- sidecar is absent or carries no "root" — two states no reader tells apart.
  root_prompt   TEXT
);

CREATE INDEX IF NOT EXISTS session_modified_idx   ON session(modified);
CREATE INDEX IF NOT EXISTS session_session_id_idx ON session(session_id);
CREATE INDEX IF NOT EXISTS session_started_idx    ON session(started);

-- The appended step stream, in transcript line order. "idx" is the node's own
-- 0-based position, stored rather than re-derived: the agent linkage and the
-- graph's deep links both address by it.
CREATE TABLE IF NOT EXISTS session_node (
  thread_id    TEXT NOT NULL REFERENCES session(thread_id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  text         TEXT NOT NULL,
  tool         TEXT,
  task         TEXT,
  interruption TEXT,
  interrupted  INTEGER NOT NULL,
  message      INTEGER,
  PRIMARY KEY (thread_id, idx)
);

CREATE INDEX IF NOT EXISTS session_node_type_idx ON session_node(type);

-- The <threadId>.nodes.jsonl sidecar: the untruncated text behind a gisted
-- node line. Not a column on session_node and not keyed to it — the sidecar is
-- sparse and can name an index the transcript no longer has, which the file
-- reader returns rather than drops.
CREATE TABLE IF NOT EXISTS session_node_text (
  thread_id TEXT NOT NULL REFERENCES session(thread_id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  PRIMARY KEY (thread_id, idx)
);
`;

/**
 * Slice 3 — command runs. The source is `logs/commands/runs.jsonl`, the
 * append-only store `reconcileCommandRuns` distils out of the transcripts and
 * the captured requests before they age out.
 *
 * **Why a `document` column sits beside the normalized tree.** A run is a
 * *stored document*, not something re-derived from its source on every read:
 * `isCommandRun` checks three identity fields, so a record from a newer or older
 * writer is kept and rendered from what it has, and half the record's fields are
 * optional for that reason. Rebuilding one from columns cannot reproduce "this
 * key was absent" versus "this key held the default", and would silently drop a
 * future writer's fields once slice 5 flips reads to DB-backed. So the record
 * round-trips through `document`, and the tables below exist to be *queried* —
 * cross-run step aggregates are a GROUP BY here and a full re-parse otherwise.
 *
 * The store stays the source of truth: every row, `document` included, is
 * rebuilt by re-reading `runs.jsonl`.
 */
const COMMAND_TABLES = `
CREATE TABLE IF NOT EXISTS command_run (
  -- The record's own id: a thread id for a top-level run, \`<threadId>~<node>\`
  -- for a nested one. Not the thread id, because a nested run is a *slice* of
  -- its host's transcript and so shares that thread with it.
  run_id          TEXT PRIMARY KEY,
  -- Position of the record's *first* line in the store. The file reader keys a
  -- Map by run id and sorts it stably, so first-appearance order is what
  -- breaks ties between two runs with the same "started".
  ord             INTEGER NOT NULL,
  command         TEXT NOT NULL,
  args            TEXT,
  prompt          TEXT,
  command_hash    TEXT,
  schema_version  INTEGER NOT NULL,
  model           TEXT,
  started         TEXT,
  ended           TEXT,
  outcome         TEXT,
  interruption    TEXT,
  reached_end     INTEGER NOT NULL DEFAULT 0,
  -- The append-only store retracts a record by rewriting it with this set;
  -- readers drop it. Stored rather than filtered at ingest so the tombstone
  -- stays queryable.
  retired         INTEGER NOT NULL DEFAULT 0,
  totals_input          INTEGER NOT NULL DEFAULT 0,
  totals_output         INTEGER NOT NULL DEFAULT 0,
  totals_cache_read     INTEGER NOT NULL DEFAULT 0,
  totals_cache_creation INTEGER NOT NULL DEFAULT 0,
  totals_real_input     INTEGER NOT NULL DEFAULT 0,
  totals_cost           REAL    NOT NULL DEFAULT 0,
  totals_turns          INTEGER NOT NULL DEFAULT 0,
  totals_tool_calls     INTEGER NOT NULL DEFAULT 0,
  totals_duration_ms    INTEGER NOT NULL DEFAULT 0,
  meta_turns_unmapped   INTEGER NOT NULL DEFAULT 0,
  meta_nodes            INTEGER NOT NULL DEFAULT 0,
  meta_attributed       INTEGER NOT NULL DEFAULT 0,
  meta_anchored         INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT,
  -- The record's own JSON line, verbatim. See the note above.
  document        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS command_run_command_idx ON command_run(command);
CREATE INDEX IF NOT EXISTS command_run_started_idx ON command_run(started);
CREATE INDEX IF NOT EXISTS command_run_outcome_idx ON command_run(outcome);

-- The facet the command page filters on, one row per flag.
CREATE TABLE IF NOT EXISTS command_run_flag (
  run_id    TEXT NOT NULL REFERENCES command_run(run_id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,
  flag      TEXT NOT NULL,
  PRIMARY KEY (run_id, ord)
);

CREATE INDEX IF NOT EXISTS command_run_flag_flag_idx ON command_run_flag(flag);

-- The run's agent family, root first: the root session plus every subagent
-- beneath it, at any depth. The join back to slice 2's session rows.
CREATE TABLE IF NOT EXISTS command_run_thread (
  run_id           TEXT NOT NULL REFERENCES command_run(run_id) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  member_thread_id TEXT NOT NULL,
  PRIMARY KEY (run_id, ord)
);

CREATE INDEX IF NOT EXISTS command_run_thread_member_idx ON command_run_thread(member_thread_id);

-- Every captured request the family sent, placed against the step that was
-- current when it went out. "file" points at the audit sidecar, which is a
-- request(id) while that day is still on disk and dangles once it is pruned —
-- the run record outlives its evidence by design, so this is not a foreign key.
CREATE TABLE IF NOT EXISTS command_run_turn (
  run_id         TEXT NOT NULL REFERENCES command_run(run_id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,
  file           TEXT NOT NULL,
  timestamp      TEXT,
  turn_thread_id TEXT,
  step           TEXT,
  node           INTEGER,
  tokens_input          INTEGER NOT NULL DEFAULT 0,
  tokens_output         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
  tokens_real_input     INTEGER NOT NULL DEFAULT 0,
  system_bytes   INTEGER NOT NULL DEFAULT 0,
  tools_bytes    INTEGER NOT NULL DEFAULT 0,
  tool_count     INTEGER NOT NULL DEFAULT 0,
  message_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, ord)
);

CREATE INDEX IF NOT EXISTS command_run_turn_file_idx ON command_run_turn(file);
CREATE INDEX IF NOT EXISTS command_run_turn_step_idx ON command_run_turn(step);

-- One declared step's slice of one run, with the rework counters tallied on it.
-- "step" is null for the unattributed bucket, which the UI shows rather than
-- hides, so it cannot be the key on its own.
CREATE TABLE IF NOT EXISTS command_run_step (
  run_id     TEXT NOT NULL REFERENCES command_run(run_id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  step       TEXT,
  title      TEXT,
  reached    INTEGER NOT NULL DEFAULT 0,
  confidence TEXT,
  tokens_input          INTEGER NOT NULL DEFAULT 0,
  tokens_output         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
  tokens_real_input     INTEGER NOT NULL DEFAULT 0,
  cost       REAL    NOT NULL DEFAULT 0,
  turns      INTEGER NOT NULL DEFAULT 0,
  nodes      INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  waste_errored_tools     INTEGER NOT NULL DEFAULT 0,
  waste_duplicate_reads   INTEGER NOT NULL DEFAULT 0,
  waste_retried_after_error INTEGER NOT NULL DEFAULT 0,
  waste_no_op_turns       INTEGER NOT NULL DEFAULT 0,
  waste_cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, ord)
);

CREATE INDEX IF NOT EXISTS command_run_step_step_idx ON command_run_step(step);

-- Which deterministic rules fired, and where. The cross-run frequency the run
-- page shows is a GROUP BY over this.
CREATE TABLE IF NOT EXISTS command_run_pattern (
  run_id     TEXT NOT NULL REFERENCES command_run(run_id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  pattern_id TEXT NOT NULL,
  title      TEXT,
  detail     TEXT,
  step       TEXT,
  node       INTEGER,
  PRIMARY KEY (run_id, ord)
);

CREATE INDEX IF NOT EXISTS command_run_pattern_id_idx ON command_run_pattern(pattern_id);

-- Per-file watermark for a mutable file that is not one of a directory's many.
-- Slice 1's ingest_watermark keys on a directory listing and slice 2's lives on
-- the session row; a single append-only store is neither.
CREATE TABLE IF NOT EXISTS file_watermark (
  path       TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  modified   TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);
`;

/**
 * Slice 3 rekeyed — the command tables key on the record's **run id**, not its
 * thread id. A nested run (`/clean` invoked inside `/task`) is a slice of its
 * host's transcript and shares that host's thread, so a thread id stopped being
 * unique the moment nested runs were recorded and `command_run`'s primary key
 * would have collided on the second row of a thread.
 *
 * The tables are dropped and rebuilt rather than altered: the substrate is a
 * disposable view, so the cheapest correct migration is to throw the rows away
 * and re-ingest. The store's `file_watermark` row goes with them, or the next
 * pass would see an unchanged `stat` and skip the re-parse, leaving the tables
 * empty.
 */
/**
 * System-prompt identity, added alongside the scalar `req_system_bytes`. The
 * outline itself stays in `logs/system-prompts/<hash>.json`; only the hash and
 * its two counts belong in a row. Nullable throughout — a sidecar written before
 * the capture existed, or a request that carried no system prompt, has none.
 *
 * Clearing the watermarks forces a rescan of every archived day, so rows already
 * ingested pick the columns up on the next pass.
 */
const SCHEMA_V7 = `
ALTER TABLE request ADD COLUMN req_system_hash     TEXT;
ALTER TABLE request ADD COLUMN req_system_blocks   INTEGER;
ALTER TABLE request ADD COLUMN req_system_sections INTEGER;

CREATE INDEX IF NOT EXISTS request_system_hash_idx ON request(req_system_hash);

DELETE FROM ingest_watermark;
`;

/**
 * `totals_wall_ms` — a run's end-to-end wall clock, beside the request span
 * `totals_duration_ms` already holds. See `CommandRunTotals.wallMs`.
 *
 * Dropping the store's watermark is what makes the column fill: the table is only rebuilt
 * when the file looks changed, and migrating the schema does not change the file. Records
 * written before the field carry 0 regardless — it is computed at capture time.
 */
const SCHEMA_V8 = `
ALTER TABLE command_run ADD COLUMN totals_wall_ms INTEGER NOT NULL DEFAULT 0;

DELETE FROM file_watermark WHERE path = 'commands/runs.jsonl';
`;

/**
 * `cache_breakpoint_injected` — whether the proxy put a message-level
 * `cache_control` breakpoint back on the request (see `proxy/cache-breakpoint.ts`).
 *
 * Nullable rather than `NOT NULL DEFAULT 0`, so a sidecar written before the
 * injector existed stays distinguishable from one that recorded "did not inject".
 * That distinction is the point: the column is read back as a per-day count, and
 * the injector is retired once the count stays at zero — which only means anything
 * if zero is a real observation rather than the absence of one.
 *
 * Clearing the watermarks forces a rescan of every archived day, so rows already
 * ingested pick the column up on the next pass.
 */
const SCHEMA_V9 = `
ALTER TABLE request ADD COLUMN cache_breakpoint_injected INTEGER;

DELETE FROM ingest_watermark;
`;

/**
 * `cache_breakpoint_observed` — whether the CLI dropped the message breakpoint on
 * the request at all, and `cache_breakpoint_declined_by` — which gate turned an
 * observed occurrence away (see `proxy/cache-breakpoint.ts`).
 *
 * Both nullable for the same reason slice 9's column is: a sidecar written before
 * the field existed must stay distinguishable from one that recorded "no". The
 * observation column carries the retirement trigger — a day of zero injections is
 * also what a still-broken CLI plus a declining gate looks like — and `declined_by`
 * says which threshold accounts for the difference.
 *
 * `declined_by` is TEXT rather than a coded integer so a gate added later reads back
 * without another migration; its null means "nothing declined", which the
 * observation column disambiguates from "nothing was recorded".
 *
 * Clearing the watermarks forces a rescan of every archived day, so rows already
 * ingested pick the columns up on the next pass.
 */
const SCHEMA_V10 = `
ALTER TABLE request ADD COLUMN cache_breakpoint_observed    INTEGER;
ALTER TABLE request ADD COLUMN cache_breakpoint_declined_by TEXT;

DELETE FROM ingest_watermark;
`;

/**
 * `session_node.turn` — which assistant turn emitted a call. See `SessionNode.turn`.
 *
 * Nullable, and null is a real reading rather than a gap: a transcript written before the
 * `▸` marker existed records no boundary, which `serial-discovery` reads as "unknown".
 *
 * Blanking `bytes` is what makes the column fill — a transcript is re-parsed only when its
 * `stat` differs from the row's, and migrating does not touch the file.
 */
const SCHEMA_V11 = `
ALTER TABLE session_node ADD COLUMN turn INTEGER;

UPDATE session SET bytes = -1;
`;

/**
 * The join keys the proxy now records at capture time, in place of downstream inference.
 *
 * - `request.thread_id` — which transcript a captured request is a turn of. A session id
 *   is shared by a run and every subagent under it, so it cannot say that on its own.
 * - `session_node.args_hash` — a fingerprint of a call's whole argument object, beside
 *   the truncated display signature already in `text`.
 * - `session.parent_thread_id` / `spawn_index` / `spawn_agent_type` — the parentage the
 *   child's own transcript header records.
 *
 * All nullable, and null is a real reading: a sidecar or transcript written before the
 * proxy wrote the field, which the readers fall back to inference for.
 *
 * Clearing the request watermark re-reads the sidecars; blanking `bytes` is what makes a
 * transcript re-parse, since migrating does not touch the file its `stat` is compared to.
 */
const SCHEMA_V12 = `
ALTER TABLE request ADD COLUMN thread_id TEXT;
ALTER TABLE session_node ADD COLUMN args_hash TEXT;
ALTER TABLE session ADD COLUMN parent_thread_id  TEXT;
ALTER TABLE session ADD COLUMN spawn_index       INTEGER;
ALTER TABLE session ADD COLUMN spawn_agent_type  TEXT;

CREATE INDEX IF NOT EXISTS request_thread_idx ON request(thread_id);

DELETE FROM ingest_watermark;
UPDATE session SET bytes = -1;
`;

const SCHEMA_V4 = `
DROP TABLE IF EXISTS command_run_pattern;
DROP TABLE IF EXISTS command_run_step;
DROP TABLE IF EXISTS command_run_turn;
DROP TABLE IF EXISTS command_run_thread;
DROP TABLE IF EXISTS command_run_flag;
DROP TABLE IF EXISTS command_run;
DELETE FROM file_watermark WHERE path = 'commands/runs.jsonl';
${COMMAND_TABLES}
`;

/**
 * Concepts. The source is `logs/concepts.jsonl`, the append-only store `/teach`
 * writes one record to at the end of a run. A feature on the finished substrate,
 * not a migration slice — the campaign closed at slice 6.
 *
 * The store has no key and nothing ever retracts a line, so a record's identity
 * *is* its position in the file: `ord` is the primary key, and the table is
 * replaced wholesale whenever the store changes rather than upserted into. Two
 * runs may save the same term twice, and both rows are kept — that is the file's
 * own reading of itself.
 *
 * `document` sits beside the normalized columns for the same reason it does on
 * `command_run`: the record round-trips through it, so a read answers with what
 * the file said rather than something rebuilt from columns, while the columns
 * beside it exist to be queried.
 */
const CONCEPT_TABLES = `
CREATE TABLE IF NOT EXISTS concept (
  -- Position of the record's line in the store. See the note above.
  ord       INTEGER PRIMARY KEY,
  term      TEXT NOT NULL,
  sentence  TEXT NOT NULL,
  field     TEXT NOT NULL,
  saved_at  TEXT NOT NULL,
  -- The record's own JSON, verbatim.
  document  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS concept_term_idx     ON concept(term);
CREATE INDEX IF NOT EXISTS concept_field_idx    ON concept(field);
CREATE INDEX IF NOT EXISTS concept_saved_at_idx ON concept(saved_at);

-- The skills consulted for one concept, one row each — the facet a listing can
-- group by without unpacking every \`document\`.
CREATE TABLE IF NOT EXISTS concept_skill (
  ord       INTEGER NOT NULL REFERENCES concept(ord) ON DELETE CASCADE,
  skill_ord INTEGER NOT NULL,
  skill     TEXT NOT NULL,
  PRIMARY KEY (ord, skill_ord)
);

CREATE INDEX IF NOT EXISTS concept_skill_skill_idx ON concept_skill(skill);
`;

/**
 * The concept detail fields — `notes`, `tips`, `sources` and `surfacedSkills`.
 *
 * All four are optional, so `notes` defaults to the empty string and the lists
 * contribute no rows for a record that lacks them. The record still round-trips
 * through \`document\`; these exist to be queried.
 *
 * The three lists share one table rather than getting a \`concept_skill\` each —
 * only grouping by skill is a real question, and \`kind\` keeps them apart.
 *
 * Dropping the store's watermark is what makes the new columns fill: the table
 * is only rebuilt when the file looks changed, and migrating the schema does not
 * change the file.
 */
const CONCEPT_DETAIL = `
ALTER TABLE concept ADD COLUMN notes TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS concept_item (
  ord      INTEGER NOT NULL REFERENCES concept(ord) ON DELETE CASCADE,
  -- 'tip', 'source' or 'surfaced_skill'.
  kind     TEXT NOT NULL,
  item_ord INTEGER NOT NULL,
  item     TEXT NOT NULL,
  PRIMARY KEY (ord, kind, item_ord)
);

CREATE INDEX IF NOT EXISTS concept_item_kind_idx ON concept_item(kind, item);

DELETE FROM file_watermark WHERE path = 'concepts.jsonl';
`;

/**
 * Open (creating if needed) the substrate for `logDir` in WAL mode. WAL lets the
 * server read while an ingest pass writes, which is the normal state: the
 * watcher ingests whenever the proxy drops a new sidecar.
 */
export function openDb(logDir: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(resolveDbPath(logDir));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Apply any schema steps this file is newer than, then record the new version. */
function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const from = Number(row?.user_version ?? 0);
  if (from >= SCHEMA_VERSION) return;

  if (from < 1) db.exec(SCHEMA_V1);
  if (from < 2) db.exec(SCHEMA_V2);
  if (from < 3) db.exec(COMMAND_TABLES);
  if (from < 4) db.exec(SCHEMA_V4);
  if (from < 5) db.exec(CONCEPT_TABLES);
  if (from < 6) db.exec(CONCEPT_DETAIL);
  if (from < 7) db.exec(SCHEMA_V7);
  if (from < 8) db.exec(SCHEMA_V8);
  if (from < 9) db.exec(SCHEMA_V9);
  if (from < 10) db.exec(SCHEMA_V10);
  if (from < 11) db.exec(SCHEMA_V11);
  if (from < 12) db.exec(SCHEMA_V12);

  // `PRAGMA user_version` takes no bind parameters, hence the interpolation.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
