CREATE TABLE usage_records (
  record_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  event_timestamp TEXT NOT NULL,
  sidecar_json TEXT NOT NULL
);

CREATE INDEX usage_records_timestamp_idx
  ON usage_records (event_timestamp);

CREATE TABLE ingest_watermarks (
  filename TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE TABLE rejected_sidecars (
  filename TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  rejected_at TEXT NOT NULL
);

PRAGMA user_version = 1;
