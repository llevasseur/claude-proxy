---
type: adr
title: Allow blank note titles
description: Persist blank titles and render Untitled only as presentation fallback text.
tags: [architecture, notes, data-model, dashboard]
timestamp: 2026-08-16
scope: claude
provenance:
  - repo: claude-proxy
    number: "0017"
    file: docs/adrs/0017-allow-blank-note-titles.md
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 12
needs-human: true
---

# Allow blank note titles

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> because title is a separate canonical field and list/search never fetch the full body, must every note have a non-empty explicit title at creation/update, or may blank titles be stored and rendered as a derived “Untitled” label?

Requiring a title adds friction to quick capture. Synthesizing a stored title would alter canonical content and create surprising agent-visible data.

## Decision

Permit and persist blank titles. Render `Untitled` as presentation-only fallback text and never synthesize it in storage.

## Consequences

People and agents can capture a note before naming it. Every client must apply the same display fallback without treating it as content.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
