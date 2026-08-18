import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * `node:sqlite` is required at runtime, not imported: it is newer than the
 * builtin list Vite ships, so a static import makes Vitest try to resolve a
 * package called `sqlite` and fail. The `import type` above is erased before any
 * bundler sees it.
 */
// SAFETY: `createRequire` resolves the same builtin the `import type` above names, so
// the assertion restores the module's own type where `require`'s untyped return lost it.
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
export const SCHEMA_VERSION = 21;

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

/**
 * Body derivatives, extracted **before** eviction removes the body they came from.
 *
 * `md_path` / `request_path` / `blob_evicted` already make "retention deleted the
 * body, we kept the metrics" queryable — for a *metric*. A value a view reads out
 * of the body itself at query time had no such column, so `/api/skim` degraded
 * silently past the retention edge while the usage views did not. `skim_text` is
 * that value: the last user turn, bounded, computed once by `deriveBodies`.
 *
 * `body_derived` is the flag, not `skim_text IS NOT NULL` — a body that carries no
 * user turn derives a real `null`, and the two states have to stay apart or every
 * pass would re-read the same body forever.
 *
 * Bounded derived strings, deliberately **not** the content-addressed blob store
 * ADR 0004 rejected: `logs/` stays the sole source of truth and
 * `rm logs/claude-proxy.db && pnpm --filter server ingest` still reconstructs
 * everything on disk. It cannot reconstruct a derivative for a day whose body is
 * already gone — the guarantee is forward-only by construction.
 *
 * Clearing the watermarks forces one backfill visit to every archived day.
 */
const SCHEMA_V13 = `
ALTER TABLE request ADD COLUMN skim_text    TEXT;
ALTER TABLE request ADD COLUMN body_derived INTEGER NOT NULL DEFAULT 0;

DELETE FROM ingest_watermark;
`;

/**
 * One closed day's digest, kept so a restart does not recompute it — level two of
 * the cache `server/src/day-digest-memo.ts` is level one of. See
 * `server/src/db/day-digest-store.ts` for what a row means and when it is written.
 *
 * The primary key is that memo's own key, component for component: the backing,
 * the log directory, the relocated archive root (`''` for none), the reporting
 * day, and the *size* of the classifier hash set. `revision` is the one addition —
 * schema version plus digest revision — since a row, unlike a memo entry, has to
 * survive the code changes a restart used to clear.
 *
 * Derived and disposable, so no watermark is cleared and nothing is backfilled:
 * rows appear as closed days are read, and the table can be emptied at any time
 * for the price of recomputing them.
 */
const SCHEMA_V14 = `
CREATE TABLE IF NOT EXISTS day_digest (
  backing          TEXT    NOT NULL,
  log_dir          TEXT    NOT NULL,
  archive_dir      TEXT    NOT NULL,
  date             TEXT    NOT NULL,
  classifier_count INTEGER NOT NULL,
  revision         TEXT    NOT NULL,
  -- The digest as JSON, in the shape the routes already send it.
  digest           TEXT    NOT NULL,
  computed_at      TEXT    NOT NULL,
  PRIMARY KEY (backing, log_dir, archive_dir, date, classifier_count, revision)
);
`;

/**
 * `session.pr_url` — the pull request the run opened, as it recorded the url itself.
 *
 * It sits beside `root_prompt` because it comes from the same place: the
 * `<threadId>.state.json` sidecar, copied in by ingest rather than derived here. The
 * proxy writes it when a run's own `gh pr create` / `my-command-tools pr` result names a
 * pull request, so a row with it is a **record** of what that session shipped, where
 * `server/src/pr-sessions.ts` previously had only textual evidence read back out of every
 * transcript on disk.
 *
 * Nullable, and null is a real reading rather than a gap: a run that opened no pull
 * request, or one whose sidecar predates the field. `readPrSessions` falls back to the
 * transcript scan for a pull request no row names, so null costs the old behaviour and
 * nothing more.
 *
 * A derived **pointer**, deliberately not a second copy of anything ADR 0004 keeps on
 * disk: `logs/` stays the source of truth, and `rm logs/claude-proxy.db && pnpm --filter
 * server ingest` refills this column from the sidecars.
 *
 * Blanking `bytes` is what makes the column fill — a transcript is re-parsed only when its
 * `stat` differs from the row's, and migrating does not touch the file.
 */
const SCHEMA_V15 = `
ALTER TABLE session ADD COLUMN pr_url TEXT;

UPDATE session SET bytes = -1;
`;

/**
 * The repository's pull requests, one row each, so `/api/pull-requests` answers from
 * an indexed query and the `gh` call happens behind the response rather than in front
 * of it. See `server/src/db/pull-request-store.ts` for what a row means.
 *
 * **The one table here whose source is not `logs/`, and it is derived and disposable
 * for the same reason every other one is.** GitHub holds the truth; these rows are a
 * copy of what `gh pr list` last said, so deleting the file costs one full refetch and
 * no information. Nothing authored lives here, and ADR 0004 stands.
 *
 * Keyed on the **checkout** rather than on the `owner/name` slug, because that is what
 * the route has in hand — resolving a slug is four subprocess layers (`resolveSlug`),
 * and a read that ran them first would put a fork back on the request path this exists
 * to clear. The slug rides on `pull_request_repo` beside the last refresh's outcome, so
 * one keyed lookup supplies `repo`, `error`, `refError` and `fetchedAt`.
 *
 * `updated_at` is `gh`'s own `updatedAt`, indexed because the refresh's watermark is
 * `MAX(updated_at)` for the checkout — what `gh pr list --search "updated:>=<date>"` is
 * then asked for, off a field the list read already returned.
 *
 * `document` is the parsed `PullRequestRow`'s own JSON, for the same reason
 * `command_run` and `concept` carry one: the row round-trips through it, so adding a
 * displayed field later is not a migration.
 */
const SCHEMA_V16 = `
CREATE TABLE IF NOT EXISTS pull_request_repo (
  -- Absolute path of the checkout whose pull requests these are.
  repo_dir   TEXT PRIMARY KEY,
  -- \`owner/name\`, or null when the remote could not be read as GitHub.
  repo       TEXT,
  -- The last refresh's setup failure, phrased for the page. Null when it succeeded.
  error      TEXT,
  -- Why \`main\` and its pins could not be brought up to date, if they could not.
  ref_error  TEXT,
  -- When the last refresh that reached GitHub ran.
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pull_request (
  repo_dir   TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,
  -- The row's own JSON, verbatim. See the note above.
  document   TEXT    NOT NULL,
  PRIMARY KEY (repo_dir, number)
);

CREATE INDEX IF NOT EXISTS pull_request_updated_idx ON pull_request(repo_dir, updated_at);
`;

/**
 * The transcript scan's own results, so a pull request is scanned once rather than
 * once per `gh` refresh. See `server/src/db/pr-scan-store.ts`.
 *
 * Derived and disposable: `logs/sessions/` is the source of truth, so deleting the file
 * costs one scan pass and no information.
 *
 * The separation the feature doc guards is enforced by the column rather than by
 * convention: `via` holds only `branch` and `number`, the two *recovered* signals. A
 * `recorded` link is a session's own record of the pull request it opened, is read from
 * `session.pr_url` on every request, and is never written here — so a stored scanned
 * link can never age into a recorded one.
 *
 * `scanned_through` is the mtime, in epoch milliseconds, of the newest transcript that
 * existed when this pull request was scanned. A pull request is rescanned once the
 * directory holds something newer, and then only against the transcripts past that
 * mark. A row with no link rows is the useful negative — scanned, matched nothing —
 * which is what takes an unnamed pull request off the request path.
 */
const SCHEMA_V17 = `
CREATE TABLE IF NOT EXISTS pr_scan (
  -- Absolute path of the checkout the number belongs to, as \`pull_request\` is keyed.
  repo_dir        TEXT    NOT NULL,
  number          INTEGER NOT NULL,
  -- Newest transcript mtime, epoch ms, at the time of the scan.
  scanned_through INTEGER NOT NULL,
  scanned_at      TEXT    NOT NULL,
  PRIMARY KEY (repo_dir, number)
);

CREATE TABLE IF NOT EXISTS pr_scan_link (
  repo_dir  TEXT    NOT NULL,
  number    INTEGER NOT NULL,
  -- The transcript that produced the link.
  thread_id TEXT    NOT NULL,
  title     TEXT    NOT NULL,
  -- The transcript's mtime, ISO 8601, as the drawer orders by.
  modified  TEXT    NOT NULL,
  -- Comma-joined recovered signals: \`branch\`, \`number\`, or both. Never \`recorded\`.
  via       TEXT    NOT NULL,
  PRIMARY KEY (repo_dir, number, thread_id)
);

CREATE INDEX IF NOT EXISTS pr_scan_link_thread_idx ON pr_scan_link(thread_id);
`;

/**
 * One closed archived day of usage work, compacted to the fields the meters read.
 * See `server/src/db/usage-day-store.ts`.
 *
 * `day_digest` beside it holds a *daily* digest, which cannot answer a 5-hour
 * window: the usage meters need the individual requests, so this row keeps the
 * day's requests projected down to `UsageRecord` rather than summed. That is what
 * takes `/api/usage`'s 28-day learning span off the full corpus on a cold start.
 *
 * Derived and disposable, exactly like `day_digest`: no watermark is cleared and
 * nothing is backfilled, rows appear as closed days are read, and the table can be
 * emptied at any time for the price of recomputing them.
 */
const SCHEMA_V18 = `
CREATE TABLE IF NOT EXISTS usage_day (
  backing     TEXT    NOT NULL,
  log_dir     TEXT    NOT NULL,
  date        TEXT    NOT NULL,
  revision    TEXT    NOT NULL,
  -- The day's projected requests as a JSON array of \`UsageRecord\`.
  records     TEXT    NOT NULL,
  -- Files that would not parse, carried so the route's \`meta\` is unchanged.
  parse_errors INTEGER NOT NULL,
  computed_at TEXT    NOT NULL,
  PRIMARY KEY (backing, log_dir, date, revision)
);
`;

/**
 * One closed reporting day of context work, reduced to what a window read sums.
 * See `server/src/db/context-day-store.ts`.
 *
 * `day_digest` and `usage_day` beside it hold the same day for two other routes
 * and neither answers this one: a digest carries no `realInput` order statistics
 * and no per-thread peak, and a `UsageRecord` carries no drill-down handle. So
 * this row keeps the day's own `ContextDayAggregate` — the sums, the sorted token
 * counts a median needs, the day's largest requests, and the day's slice of the
 * thread index. That is what takes `/api/context?days=30` off a scan of every
 * sidecar in the window on every sort, page and search.
 *
 * Derived and disposable, exactly like the two beside it: no watermark is cleared
 * and nothing is backfilled, rows appear as closed days are read, and the table
 * can be emptied at any time for the price of recomputing them.
 */
const SCHEMA_V19 = `
CREATE TABLE IF NOT EXISTS context_day (
  backing     TEXT    NOT NULL,
  log_dir     TEXT    NOT NULL,
  date        TEXT    NOT NULL,
  revision    TEXT    NOT NULL,
  -- The day's \`ContextDayAggregate\` as JSON.
  aggregate   TEXT    NOT NULL,
  -- Files the day matched, carried so the route's \`meta\` stays a sum over days.
  files       INTEGER NOT NULL,
  parse_errors INTEGER NOT NULL,
  computed_at TEXT    NOT NULL,
  PRIMARY KEY (backing, log_dir, date, revision)
);
`;

/**
 * `skim_text` moves off `request` into its own side table, keyed by request.
 *
 * The column held the last user turn of nearly every captured body — bulky prose
 * sitting on the hot `request` pages every window read scans, long after the
 * window read itself stopped selecting it (see `entriesFrom` in `source.ts`).
 * Moving it aside shrinks what those reads touch on disk, not just what they
 * name in SQL.
 *
 * A row exists only for a **non-null** derivative. `body_derived` stays on
 * `request` as the "was this body ever read" flag, so the two states V13 kept
 * apart — derived-to-null versus never derived — survive the move: the first is
 * `body_derived = 1` with no side row, the second `body_derived = 0`.
 *
 * The backfill runs before the drop, so an existing database keeps every
 * derivative it already extracted — eviction may have taken the bodies they came
 * from, and re-deriving is forward-only by construction. `VACUUM` then returns
 * the pages the dropped column occupied; it must not run inside a transaction,
 * which is fine here because `migrate` execs each slice autocommitted.
 */
const SCHEMA_V20 = `
CREATE TABLE IF NOT EXISTS request_skim (
  request_id TEXT PRIMARY KEY REFERENCES request(id) ON DELETE CASCADE,
  skim_text  TEXT NOT NULL
);

INSERT INTO request_skim (request_id, skim_text)
  SELECT id, skim_text FROM request WHERE skim_text IS NOT NULL;

ALTER TABLE request DROP COLUMN skim_text;

VACUUM;
`;

/**
 * A covering index for the window read, so the per-day scan behind the context
 * window is answered from the index alone and never touches a `request` row.
 *
 * Leads with the predicate `readDir` issues — `source_dir = ?` plus a range over
 * `id`, not `timestamp`: an id is the proxy's UTC date prefix followed by the
 * capture time, so the id range already is the time span, and an index led by
 * `timestamp` could seek neither half. The remaining 35 columns are the rest of
 * the select list, which is what makes it covering.
 *
 * The column list has to stay in step with `REQUEST_COLUMN_SET` in `source.ts` —
 * a column added to the select and not here silently drops the plan back to a
 * table lookup. `server/test/window-covering-index.test.ts` catches that.
 *
 * Costs 25.1 MB and about 0.8µs per row on ingest; the per-day read goes from
 * 17.6ms to 11.6ms, the whole-archive read from 110.6ms to 106.8ms.
 */
const SCHEMA_V21 = `
CREATE INDEX IF NOT EXISTS request_window_covering_idx ON request(
  source_dir, id,
  timestamp, model, endpoint, status_code, session_present, session_id, thread_id, app, user_agent,
  account, metadata_session_id, device_id, tokens_input, tokens_output, tokens_cache_read,
  tokens_cache_creation, tokens_real_input, req_tool_count, req_tools_bytes, req_system_bytes,
  req_total_bytes, req_system_hash, req_system_blocks, req_system_sections, skim_present, skim_enabled,
  skim_served_from_cache, skim_saved_input_tokens, skim_cache_key, cache_breakpoint_injected,
  cache_breakpoint_observed, cache_breakpoint_declined_by, rate_limit_present, body_derived, request_path
);
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
  // SAFETY: `PRAGMA user_version` answers a single row whose single column SQLite
  // names `user_version`, which is what this row type declares.
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
  if (from < 13) db.exec(SCHEMA_V13);
  if (from < 14) db.exec(SCHEMA_V14);
  if (from < 15) db.exec(SCHEMA_V15);
  if (from < 16) db.exec(SCHEMA_V16);
  if (from < 17) db.exec(SCHEMA_V17);
  if (from < 18) db.exec(SCHEMA_V18);
  if (from < 19) db.exec(SCHEMA_V19);
  if (from < 20) db.exec(SCHEMA_V20);
  if (from < 21) db.exec(SCHEMA_V21);

  // `PRAGMA user_version` takes no bind parameters, hence the interpolation.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
