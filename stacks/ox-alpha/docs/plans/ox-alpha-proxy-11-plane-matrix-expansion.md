# Task 11 — Plane parity matrix expansion and Train closure

## Goal

Expand the grouped parity matrix into individual checkable rows, pre-closing
Train-dependent surfaces per ADR 0004. Blocked by the Boat boundary
(tasks 01–10 merged).

## Criteria

1. Expand every grouped row in `docs/roadmap/four-rungs-to-plane.md` into individual checkable rows with pinned-evidence paths verified against the local claude-proxy checkout at commit `cc25696504e724bd78824e639e97a0a1d846abea`.
2. Rows whose only producer would have been Train (ideas/suggestions/coaching, operator notes, headless daily summary, jobs/maintenance beyond read-only fallout) close `N/A` citing ADR 0004 — never silently dropped.
3. Every remaining row starts `unresolved` with a concrete evidence plan naming the test or artifact that will close it.
4. The matrix stays the single source of truth for Plane scope; the immutable comparison point remains the pinned commit.
5. Docs-only ticket: no runtime code changes; `pnpm verify` green.
6. Update the roadmap document in place; index regenerated.

## Out of scope

Implementing any unresolved row (task 12).
