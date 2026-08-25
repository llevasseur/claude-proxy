---
type: adr
title: Fuse the three proxy repositories into one monorepo
description: claude-proxy, codex-proxy and ox-alpha-proxy become one pnpm workspace with one toolchain, one docs bundle and one CI gate.
tags: [monorepo, repository, architecture, campaign]
timestamp: 2026-08-23
scope: all
provenance:
  - campaign: monorepo-fusion
    decided: before the campaign began, by the repository owner
    recorded-by: monorepo-fusion ticket 13
decided-by: user
ratified: true
wayfinder: monorepo-fusion
needs-human: false
---

# Fuse the three proxy repositories into one monorepo

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began;
this record writes down a decision already made rather than proposing a new one.

**Supersedes [0022 — Start with fresh repository history](0022-fresh-repository-history.md)
and [0023 — Publish the repository privately](0023-private-github-publication.md).**

Those two numbers are the point. Both records were originally written twice — once in
codex-proxy and once in ox-alpha-proxy — and the merge described in
[0053](0053-the-merged-corpus-replaces-its-sources.md) restated each pair **once**, at
0022 and 0023 in this corpus. The old identifiers `codex#0005`, `ox-alpha#0005`,
`codex#0006` and `ox-alpha#0006` no longer identify anything: they are lookup keys into
[legacy-map.md](legacy-map.md), not records. So this ADR supersedes **the merged records**,
cited by their numbers here, and does not supersede the originals by their old numbers,
because there is nothing at those numbers to supersede.

## Context

claude-proxy, codex-proxy and ox-alpha-proxy were built as three separate repositories,
each with its own toolchain, its own docs corpus, its own CI, and its own decision records.
They observe three different provider/harness pairs but solve one problem, and the overlap
had become the cost: three lockfiles to bump, three lint configurations to keep in step,
three sets of the same decision written down separately, and any cross-stack change landing
as three coordinated pull requests that could not be verified together.

## Decision

**The three repositories become one repository: one pnpm workspace, one toolchain, one
docs bundle, one CI gate.** Each stack keeps its packages, its ports, its defaults, and its
runtime behaviour verbatim — fusion is a repository-shape change, not a behaviour change.

Both siblings are absorbed **with their histories**, by history rewrite rather than by
copying files in, so every absorbed file keeps the commits that produced it.

### Parity with a separate repository is a category error once that repository is a sibling directory

This is the reasoning that supersedes 0022 and 0023, and it is stated outright because it
is the part most likely to be missed.

0022 decided that each sibling would start at a **fresh initial commit** and inherit
decisions by adapted republication rather than by imported history. 0023 decided that each
sibling would be **published as its own private GitHub repository**. Both were correct
while "each sibling" named a repository. Neither survives the sibling becoming a directory.

A fresh initial commit is a statement about where a repository's history begins. After
fusion there is one repository and one history, and the absorbed stacks are directories in
it — so "codex-proxy's initial commit" no longer names a boundary anything can be measured
against. A private remote is a statement about a repository's publication boundary. After
fusion there is one remote, already private, and "ox-alpha-proxy's visibility" names no
setting that exists.

The general form: **once a repository becomes a directory, every decision about that
repository *as a repository* stops having a subject.** Asking whether the fused monorepo
preserves those decisions is asking a question about an object that no longer exists.
That is why they are superseded rather than restated, weakened, or carved out.

## Consequences

- One `pnpm install`, one lockfile, one `verify` that gates all three stacks together.
- Cross-stack work is one branch and one pull request, verified as a unit.
- The absorbed histories are queryable in this repository; `docs/history/` carries the
  commit maps from the rewrite.
- 0022 and 0023 stay in the corpus. Superseded records are never deleted
  ([0001](0001-record-architecture-decisions.md)), and reading why the siblings started
  fresh and private is how the fusion's cost is understood.
- Nothing any of the three stacks does today is deleted. The campaign's rejection rule
  from [0050](0050-stack-scoped-environment-variables.md) holds: a fusion-caused
  regression is in scope to prevent, pre-existing awkwardness is out of scope to fix.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13. No prior record in any of the three source
corpora addresses fusion, because none of them could: the decision is about all three at
once.
