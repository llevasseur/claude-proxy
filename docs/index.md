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
`wayfinder/` (a campaign's map, tickets, research, and decisions), `history/` (commit maps
from absorbed repositories — data files rather than concepts, so okq does not index them).

<!-- okq:index:begin -->
### Folders

- [adrs/](adrs/)
- [features/](features/)
- [specs/](specs/)
- [wayfinder/](wayfinder/)

### Concepts

| Title | File |
|-------|------|
| Claude Usage Daily Summary — Design Spec | [2026-07-13-claude-usage-summary-design.md](2026-07-13-claude-usage-summary-design.md) |
| docs | [README.md](README.md) |
| Ideas ledger (tier 2) | [ideas.md](ideas.md) |
<!-- okq:index:end -->
