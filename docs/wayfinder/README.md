---
type: readme
title: Wayfinder — local-markdown tracker
description: How this repo tracks a wayfinder campaign in checked-in markdown — the map, its tickets, and their frontmatter.
timestamp: 2026-07-18
---

# Wayfinder — local-markdown tracker

No external issue tracker is wired for this repo, so wayfinder uses its
**local-markdown** fallback: the map and its tickets are plain markdown files here,
checked into the repo.

## Layout

```
docs/wayfinder/
  map-<slug>.md        the map (label wayfinder:map). One per effort.
  tickets/
    NNN-<slug>.md      a child ticket of the map. Zero-padded id = identity.
```

A map tracks its work in one of two shapes. Numbered ticket files, as in `map-proxy-skim`,
suit an effort whose pieces are decided separately and may be reordered. A checkbox slice
ledger inside the map body, with a per-slice note of what actually landed, suits a linear
campaign where each slice is one run and one merge — `map-sqlite-substrate` is that shape
and has no tickets at all. For a ledger map the git history of `main` is the authority for
what is checked.

## Ticket frontmatter

```yaml
---
type: ticket                    # required by okq validate
id: "001"                       # identity; referenced by blockedBy
title: Exact-match skim short-circuit
map: map-proxy-skim
labels: ["wayfinder:prototype"] # one of research|prototype|grilling|task
assignee: null                  # null = unclaimed; a name = claimed
blockedBy: []                   # ids that must be closed first
status: open                    # open | closed
---
```

Quote the label: a bare `wayfinder:prototype` inside a `[…]` flow sequence is invalid
YAML (the colon reads as a mapping indicator), which makes the whole ticket unparseable
to `okq`.

## Wayfinding operations (this tracker)

- **Map body** — `map-<slug>.md`. Loaded once per session.
- **Child tickets** — files in `tickets/` whose `map:` matches.
- **Claim** — set `assignee:` to the dev, before any work.
- **Blocking** — `blockedBy: [ids]`. A ticket is *unblocked* when every id in
  its `blockedBy` is a `status: closed` ticket.
- **Frontier query** — open + unblocked + unassigned tickets, lowest id first.
- **Resolve** — append a `## Resolution` section to the ticket, set
  `status: closed`, then add a one-line pointer to the map's *Decisions so far*.
