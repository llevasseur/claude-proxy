-- Notes store, schema 3.
--
-- Every authored write is retained in note_revision. note_current is the small
-- mutable projection used for reads, ordering, optimistic concurrency, and
-- reversible archive state. A losing update remains as a conflict revision so
-- neither writer's Markdown is destroyed.

CREATE TABLE note_revision (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL,
  version       INTEGER NOT NULL,
  base_version  INTEGER,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('committed', 'conflict', 'pending'))
);

CREATE INDEX note_revision_note ON note_revision (note_id, created_at DESC, id DESC);

CREATE TABLE note_current (
  id                   TEXT PRIMARY KEY,
  current_revision_id  TEXT NOT NULL REFERENCES note_revision (id),
  version              INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  archived_at          TEXT
);

CREATE INDEX note_current_active_order ON note_current (archived_at, updated_at DESC, id DESC);

CREATE VIRTUAL TABLE note_fts USING fts5 (
  revision_id UNINDEXED,
  title,
  body
);
