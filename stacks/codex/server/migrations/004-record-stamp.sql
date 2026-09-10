-- 004 — the record stamp.
--
-- Adds three of the four fields the adapter contract stamps on a record.
-- The fourth, `model`, has been a column since 003 and is not added twice.
--
-- `cost` and `pricing_source` are deliberately absent. Both are functions of a
-- rate table an operator may edit at any moment, so ADR 0065 resolves them at
-- read time rather than freezing them here.
--
-- The defaults are what backfill the rows already in the store, and they are
-- correct rather than convenient: every row this database can hold was written
-- by codex-proxy, which observes the OpenAI wire under the Codex harness at
-- adapter version 1. Ingest supplies all three explicitly on every insert.
--
-- `provider` and `harness` are two independent columns with no constraint
-- tying them together, because ADR 0040 forbids deriving either from the other.

ALTER TABLE usage_records ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE usage_records ADD COLUMN harness TEXT NOT NULL DEFAULT 'codex';
ALTER TABLE usage_records ADD COLUMN adapter_version INTEGER NOT NULL DEFAULT 1;

PRAGMA user_version = 4;
