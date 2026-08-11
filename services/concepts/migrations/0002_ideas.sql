-- Ideas ledger, schema 2. See docs/adrs/0006-host-the-ideas-ledger.md.
--
-- Two tables with deliberately different characters, and the difference is the
-- whole design:
--
--   `idea_event` is append-only and holds the ledger's meaning. Nothing updates
--   or deletes a row. A read replays every event through the apply functions in
--   `packages/core/src/ideas.ts`, so no status rule, evidence rule or filing
--   rule is restated here in SQL.
--
--   `idea_claim` is mutable and holds no meaning at all. It is a lease: one row
--   per held idea, taken by a single conditional UPDATE whose `changes` count
--   decides which of two racing runs won. It exists because the claim is the one
--   thing replay cannot arbitrate — two devices both reading "unclaimed" and
--   both appending a claim event would both believe they won.

CREATE TABLE idea_event (
  -- Insertion order, and the replay tiebreaker within one timestamp.
  --
  -- **`id` cannot do this job**, which is worth stating because the concept
  -- store orders by its id and this table deliberately does not: the low bits
  -- of a derived ULID are a *hash*, so two events written in the same
  -- millisecond — an add and the mark that accepts it, a mark and a re-file —
  -- would replay in hash order, and a mark replayed before its add applies to
  -- an idea that does not exist yet and is dropped.
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ULID, derived from the event's own bytes. See src/ulid.ts: replaying a
  -- write lands on the row it already wrote, which is what makes the importer
  -- safe to run on every device and safe to run twice.
  id       TEXT NOT NULL UNIQUE,
  slug     TEXT NOT NULL,
  -- add | mark | file | comment. Claiming is not an event — see `idea_claim`.
  kind     TEXT NOT NULL,
  -- ISO timestamp the event happened. Replay order, and the `now` each apply
  -- function is given, so `created` and `updated` come out of the log rather
  -- than out of whenever the read happened to run.
  at       TEXT NOT NULL,
  -- The event payload verbatim, in the shape the matching apply function takes.
  document TEXT NOT NULL
);

-- The replay order, which is every read's only access path.
CREATE INDEX idea_event_at ON idea_event (at, seq);
CREATE INDEX idea_event_slug ON idea_event (slug, at, seq);

CREATE TABLE idea_claim (
  slug   TEXT PRIMARY KEY,
  -- A branch, a run id, a person — whatever a second run can recognise as not
  -- itself.
  holder TEXT NOT NULL,
  at     TEXT NOT NULL,
  -- The PR pinning the claim open. A claim carrying one never expires by age,
  -- which is why the take condition tests `pr IS NULL` rather than `at` alone.
  pr     TEXT
);
