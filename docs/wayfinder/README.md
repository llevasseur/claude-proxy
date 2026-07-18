# Wayfinder — local-markdown tracker

No external issue tracker is wired for this repo, so wayfinder uses its
**local-markdown** fallback: the map and its tickets are plain markdown files
here, checked into the repo.

## Layout

```
docs/wayfinder/
  map-<slug>.md        the map (label wayfinder:map). One per effort.
  tickets/
    NNN-<slug>.md      a child ticket of the map. Zero-padded id = identity.
```

## Ticket frontmatter

```yaml
---
id: "001"                     # identity; referenced by blockedBy
title: Exact-match skim short-circuit
map: map-proxy-skim
labels: [wayfinder:prototype] # one of research|prototype|grilling|task
assignee: null                # null = unclaimed; a name = claimed
blockedBy: []                 # ids that must be closed first
status: open                  # open | closed
---
```

## Wayfinding operations (this tracker)

- **Map body** — `map-<slug>.md`. Loaded once per session.
- **Child tickets** — files in `tickets/` whose `map:` matches.
- **Claim** — set `assignee:` to the dev, before any work.
- **Blocking** — `blockedBy: [ids]`. A ticket is *unblocked* when every id in
  its `blockedBy` is a `status: closed` ticket.
- **Frontier query** — open + unblocked + unassigned tickets, lowest id first.
- **Resolve** — append a `## Resolution` section to the ticket, set
  `status: closed`, then add a one-line pointer to the map's *Decisions so far*.
