import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * `node:sqlite` is required at runtime, not imported: it is newer than the
 * builtin list Vite ships, so a static import makes Vitest try to resolve a
 * package called `sqlite` and fail. The `import type` above is erased before any
 * bundler sees it.
 */
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

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
  return path.join(logDir, "claude-proxy.db");
}

/**
 * Schema version, tracked in `PRAGMA user_version`. Bump it and add a migration
 * step below when the shape changes, so an existing file survives a `git pull`.
 */
export const SCHEMA_VERSION = 2;

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
 * Open (creating if needed) the substrate for `logDir` in WAL mode. WAL lets the
 * server read while an ingest pass writes, which is the normal state: the
 * watcher ingests whenever the proxy drops a new sidecar.
 */
export function openDb(logDir: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(resolveDbPath(logDir));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** Apply any schema steps this file is newer than, then record the new version. */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const from = Number(row?.user_version ?? 0);
  if (from >= SCHEMA_VERSION) return;

  if (from < 1) db.exec(SCHEMA_V1);
  if (from < 2) db.exec(SCHEMA_V2);

  // `PRAGMA user_version` takes no bind parameters, hence the interpolation.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
