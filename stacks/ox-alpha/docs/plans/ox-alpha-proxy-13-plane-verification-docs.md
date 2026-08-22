# Task 13 — Plane verification sweep and operational docs

## Goal

Final verification pass over all four rungs and documentation completeness,
preparing the campaign for close. Blocked by task 12.

## Criteria

1. Full-matrix audit: zero `unresolved` rows; each `implemented` row's evidence re-checked; each `N/A` row's rationale row-specific.
2. Aggregate verification: fresh clone bootstrap, `pnpm install --frozen-lockfile && pnpm verify`, plus cross-phase regression coverage (Bike forwarding fidelity with Car history present; Car summaries correct with capture on; inspection flows degrade without capture).
3. Operational documentation complete: README setup, `.env.example` accuracy, headless operation paths, recovery drills (delete DB and rebuild from sidecars), feature/spec/ADR coverage matching shipped reality.
4. Each phase boundary's "live validation outstanding" note consolidated into one section listing exactly what live end-to-end validation the human still owes (ADR 0011).
5. Roadmap matrix statuses final; durable docs updated wherever implementation deviated.
6. `pnpm verify` green.

## Out of scope

Opening or merging the campaign pull request (the close operation owns that).
