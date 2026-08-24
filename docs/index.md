---
okf_version: "0.1"
---

# docs

An [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(OKF) bundle — Markdown + YAML frontmatter, one concept per file. Query it with okq:

    okq find --type adr
    okq search "<topic>"
    okq stats

Folders: `adrs/` (decisions), `specs/` (design specs), `features/` (one per capability),
`roadmap/` (delivery ladders), `wayfinder/` (a campaign's map, tickets, research, and
decisions), `history/` (commit maps from absorbed repositories — data files rather than
concepts, so okq does not index them).

## One bundle, three stacks

This is the whole repository's knowledge base — `claude`, `codex` and `ox-alpha` all
record here, and no stack keeps a second bundle under `stacks/`. A document inherited from
a sibling carries `scope` naming the stack it governs and `provenance` naming the
repository and path it came from; a document with no `scope` is claude's.

`scope` is what lets one flat corpus hold two answers without contradicting itself. codex
climbs a five-rung delivery ladder and ox-alpha a four-rung one, and both records stand
because each says which stack it is about — the reasoning
[ADR 0021](adrs/0021-outcome-ladder.md) sets out. Old sibling ADR identifiers resolve
through [adrs/legacy-map.md](adrs/legacy-map.md).

<!-- okq:index:begin -->
### Folders

- [adrs/](adrs/)
- [features/](features/)
- [roadmap/](roadmap/)
- [specs/](specs/)
- [wayfinder/](wayfinder/)

### Concepts

| Title | File |
|-------|------|
| Claude Usage Daily Summary — Design Spec | [2026-07-13-claude-usage-summary-design.md](2026-07-13-claude-usage-summary-design.md) |
| docs | [README.md](README.md) |
| Ideas ledger (tier 2) | [ideas.md](ideas.md) |
<!-- okq:index:end -->
