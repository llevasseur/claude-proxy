---
type: adr
title: Supersession is recorded from both ends
description: A superseded record carries `superseded-by` naming its successor, and the docs gate fails a link that only points one way.
tags: [docs, adrs, tooling, verification]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 0
needs-human: false
---

# Supersession is recorded from both ends

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign. A human has not ratified it.
Not flagged `needs-human`: it adds a frontmatter key and an assertion over the corpus,
and changes no stack's runtime behaviour.

## Context

Supersession in this corpus was discoverable **only forward**. A later record names what
it supersedes — [0039](0039-fuse-the-three-proxy-repos-into-one-monorepo.md) names 0022
and 0023, [0047](0047-sqlite-substrate-with-forward-only-migrations.md) names 0028 — and
nothing named what superseded it. No `superseded-by` key existed anywhere under
`docs/adrs/`.

So a reader arriving at 0022, 0023 or 0028 had no way to learn they had been replaced.
Those records read as current, and read convincingly: each is a complete, accepted
decision with its own reasoning. [0053](0053-the-merged-corpus-replaces-its-sources.md)
records this defect at the point it was noticed; this record fixes it. In a corpus the
campaign had just tripled in size, that is a navigation defect rather than a tidiness one
— the odds of arriving at a record by search rather than by reading forward from its
successor went up threefold.

## Decision

**Every superseded record carries `superseded-by` in its frontmatter, naming its
successor's four-digit number as a quoted string.** The quoting matches the existing
`provenance[].number` convention and keeps the leading zero out of YAML's hands.

**The docs gate asserts the relation bidirectionally.** For every `superseded-by: X` on
record N, the gate requires that X exists as a record, and that X declares in its own
prose that it supersedes N — a paragraph mentioning supersession and linking N's file.
**Bidirectional or it fails.** A one-way link is precisely what produced this defect, so
a gate checking only the direction that already worked would let it recur silently.

**The set is derived, not hand-listed.** It comes from scanning the corpus's existing
forward references, which yields exactly three: 0022 and 0023 superseded by 0039, and
0028 superseded by 0047.

**Two things that look like supersession are deliberately excluded.**

- **A merged pair is not a supersession.** [0053](0053-the-merged-corpus-replaces-its-sources.md)
  draws that distinction and [legacy-map.md](legacy-map.md) restates it. The records
  carrying "This record replaces both originals rather than superseding them" — 0018,
  0019, 0020, 0021, 0022, 0023, 0024, 0025 — must not acquire this key by association
  with the word. 0022 and 0023 do carry it, but for 0039's decision, not for the merge.
- **A partial supersession is not one either.**
  [0003](0003-allow-narrowly-scoped-writes-in-the-local-server.md) supersedes the
  read-only `server/` constraint in [0002](0002-monorepo-with-pnpm-tanstack-and-node.md)
  and says outright that the rest of 0002 remains in force. Marking 0002
  `superseded-by: 0003` would tell a reader to disregard a record that still governs. It
  is left unmarked, and the key stays a whole-record relation.

## Consequences

- A reader landing on 0022, 0023 or 0028 from search now learns immediately that
  something replaced it, and which record that is.
- The gate is what keeps the two directions in step. Adding `superseded-by` without a
  matching forward declaration fails `check`, and so does naming a record that does not
  exist — both were exercised against the corpus before this landed.
- The key is whole-record. A decision that supersedes part of another record states that
  in prose, as 0003 does, and adds no key.
- Superseded records are still never deleted; [0001](0001-record-architecture-decisions.md)
  is untouched, and this record only makes the existing relation legible from the other
  side.

## Provenance

Decided in this repository during `monorepo-fusion`, from the navigation defect
[0053](0053-the-merged-corpus-replaces-its-sources.md) recorded but did not fix.
