# monorepo-fusion-25 — Retire the sibling docs trees into the root bundle

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-25-retire-the-sibling-docs-trees`
**Status:** active

## Why this ticket exists

**This is a gap in the campaign's charting, not a ticket that slipped.** The campaign's docs
goal is "one root OKF bundle". Ticket 12 merged the three ADR corpora into `docs/adrs/`, and
ticket 11 repairs the docs gate — but nothing was ever charted for the rest of the sibling
bundles, and they are still in place:

```
stacks/codex/docs/{adrs,features,roadmap,specs,index.md}
stacks/ox-alpha/docs/{adrs,features,roadmap,specs}
```

Two consequences, and the first is a direct contradiction of a ratified decision:

**ADR 0053 says the merged record *replaces* both sources**, with the originals persisting as
git history — which is the form ox ADR 0010 blessed. While `stacks/*/docs/adrs/` stand, each
of the eight shared decisions is stated in **more than one live file**. That is precisely the
"contradicts itself on day one" case ox 0010 was written to prevent, arriving by a different
route than the one it anticipated. Ticket 12 flagged this and correctly stayed in its lane.

**And `features/`, `roadmap/` and `specs/` were never merged at all** — not by ticket 12,
which owned ADRs, nor by any other ticket.

## Criteria

1. **Retire `stacks/codex/docs/adrs/` and `stacks/ox-alpha/docs/adrs/`.** Their content is
   already in the root corpus at 0001–0038, and `docs/adrs/legacy-map.md` resolves every old
   identifier. **Before removing, spot-check the map**: pick several records from each and
   confirm the mapping resolves to a root record that says the same thing. Report what you
   checked. If any record has no mapping, stop and report rather than deleting it.
2. **Merge `features/`, `roadmap/` and `specs/` into the root bundle**, each document
   carrying `scope: codex` or `scope: ox-alpha` and a `provenance` field, matching what
   ticket 12 established for ADRs. Keep the rung-ladder documents — ox's admin and core are
   literally organised by rung, and `docs/roadmap/four-rungs-to-plane.md` is the only document
   explaining that shape.
3. **Do not flatten a scoped disagreement into a contradiction.** codex's five-rung ladder and
   ox's four are two *scoped* decisions, exactly as ticket 12 handled them in the merged ADR
   0021. The `scope` field is what makes a flat corpus honest.
4. **Resolve `stacks/codex/docs/index.md`** into the root bundle's index rather than leaving a
   second index.
5. **Check for inbound links** from each stack's source, README, or `AGENTS.md` into its own
   `docs/` tree before removing anything, and repoint them. A dangling link is how this ticket
   fails quietly — ticket 14 left exactly one and it had to be picked up later.

## Constraints

- Own `stacks/codex/docs/`, `stacks/ox-alpha/docs/`, and the root `docs/{features,roadmap,specs}/`.
- **Do not touch `docs/adrs/0001–0038`** — ticket 12 settled those and they are cited from the
  legacy map.
- **Do not touch `docs/wayfinder/`.**
- **Zero behaviour change.**

## Done when

The sibling `docs/` trees are gone, every document they held is in the root bundle carrying
`scope` and `provenance`, `okq --bundle docs validate` reports no new errors, no link dangles,
and the spot-check from criterion 1 is reported in the PR body.
