---
type: adr
title: Promise transparent HTTP forwarding
description: Forward the complete HTTP surface and extract metrics only from recognized Responses traffic.
tags: [architecture, proxy, compatibility]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0007"
    file: docs/adrs/0007-transparent-http-surface.md
  - repo: ox-alpha-proxy
    number: "0007"
    file: docs/adrs/0007-transparent-http-surface.md
decided-by: /dev
ratified: false
needs-human: true
---

# Promise transparent HTTP forwarding

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "What HTTP surface does Bike promise: only the Responses endpoint needed by current
> Codex, or transparent forwarding of every method, path, query, header, status, and
> streaming byte to the configured upstream while extracting usage only where the
> Responses protocol is understood?"

Restricting forwarding to today's observed endpoint would make the proxy itself a
compatibility gate for future Codex or OpenAI traffic.

## Decision

Forward every method, path, query, header, body, response status, and streaming byte to
and from the configured upstream. Extract usage only where the Responses protocol is
understood. Pass unknown traffic through unchanged.

## Consequences

- Compatibility tests compare proxied traffic with direct upstream fixtures.
- Metric parsing is optional and cannot control forwarding success.
- New endpoints work before the project learns how to measure them.

## Provenance

**One decision, recorded separately by two repositories, restated here once.** Merged
from `codex-proxy` `docs/adrs/0007-transparent-http-surface.md` (`codex#0007`) and
`ox-alpha-proxy` `docs/adrs/0007-transparent-http-surface.md` (`ox-alpha#0007`) during the
`monorepo-fusion` campaign, under ADR 0053. It carries codex's earlier `2026-08-19`
timestamp; ox-alpha-proxy restated it on `2026-08-22`, citing the codex record.

**Governs the `codex` and `ox-alpha` stacks.** The two Decision sections differed in one
word: codex-proxy named "the configured OpenAI upstream" where ox-alpha-proxy named "the
configured upstream". The merged statement keeps ox-alpha's wording, because ADR 0018
already settled that the upstream host is deployment configuration rather than an
architecture decision — naming the vendor here would re-decide that in passing.

**Ratification is preserved by union.** codex#0007 carried `needs-human: true` and
ox-alpha#0007 carried no flag; the merged record keeps the flag, because a merge may
never clear one (ADR 0052).

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
