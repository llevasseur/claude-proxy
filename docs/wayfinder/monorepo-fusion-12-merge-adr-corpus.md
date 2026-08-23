# monorepo-fusion-12 — Merge the three ADR corpora into one flat bundle

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-12-merge-adr-corpus`
**Status:** active

## Goal

One flat `docs/adrs/` holding **38** inherited records numbered 0001–0038, each carrying
`scope` and `provenance`, with a legacy map from every old identifier.

**Read ADR 0053 and ADR 0052 before starting. Both correct the brief.**

## The arithmetic, corrected

46 is a count of ADR **files** (claude 17 + codex 16 + ox 13). It is not the count of
records the merge rule produces. The eight decisions codex and ox both hold are their
`0001`–`0008`, pairwise by slug — contract, sanitized sidecars, unavailable cost, ladder,
fresh history, private publication, transparent forwarding, pinned parity. Merging them
consumes 16 and emits 8, leaving claude 17 + codex 8 + ox 5 = **38**.

## Criteria

1. **Renumber 0001–0038 by timestamp**, ties broken on the source repository's existing
   number. **The tiebreak is required, not cosmetic**: claude's 17 are all July 2026,
   codex's 16 are *all* `2026-08-19`, ox's 13 are *all* `2026-08-22`, so 29 of 38 have a
   tied sort key and the numbering is otherwise not reproducible against a re-run.
   Because claude's block sorts first and its numbers are already dense, **all 17 claude
   records keep their existing numbers** — which is why "claude 0001 keeps 0001" holds.
2. **Add two required frontmatter fields to every record**: `scope:` (one of `claude`,
   `codex`, `ox-alpha`, `all`) and `provenance:` (`{repo, number, file}`).
   `scope` is what makes a flat corpus honest — codex 0004 fixes a five-rung ladder and
   ox 0004 a four-rung ladder, and those are **two scoped decisions, not a
   contradiction**.
3. **Write ONE merged record for each of the eight pairs**, rewritten with a Provenance
   section. ox ADR 0010 forbids verbatim import. The merged record takes the **earlier**
   of the pair's two timestamps: the decision was made then and the second repository
   restated it.
4. **The merged record replaces both originals.** 38 files, not 54. The originals
   persist as **git history** — which is exactly the form ox 0010 blessed when it said
   "codex-proxy's documents remain the historical record where they live", and after
   absorption that is this repository's own history.
   - **Write the distinction into the docs**: "never delete a superseded ADR" governs
     *supersession*, a relation between a later decision and an earlier one it replaces.
     A merged pair is neither. The rule is preserved verbatim and has no subject here.
     The next reader will collide the two unless it is stated.
5. **`docs/adrs/legacy-map.md` maps every `<repo>#<old>` to `<new>`.** It is
   **many-to-one by design** — `codex#0005` and `ox#0005` both resolve to one target —
   and its header says so.
6. **Preserve every inherited ratification flag unchanged (ADR 0052).** Do not clear and
   do not ratify. **The backfill applies only to claude's 6 records that are not flagged
   `needs-human`**; the other 11 keep `ratified: false` and `needs-human: true`.
   Blanket-ratifying claude's 17 would silently ratify eleven decisions a prior run
   flagged for a human.
7. **Keep the rung-ladder ADRs.** ox's admin and core are literally organised by rung and
   `docs/roadmap/four-rungs-to-plane.md` is the only document explaining that shape.
8. **Never delete a superseded ADR.**

## Done when

`docs/adrs/` holds 38 renumbered records plus the campaign's own (0039–0056), every one
carrying `scope` and `provenance`; `legacy-map.md` resolves every old identifier;
`okq --bundle docs validate` is conformant; and
`rg -l 'needs-human:\s*true' docs/adrs/` returns **31**, which is the expected result of
a correct run rather than a failure (ADR 0052).
