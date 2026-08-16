---
type: adr
title: Use Markdown for note content
description: Keep one lossless note representation across the dashboard, REST API, and MCP tools.
tags: [architecture, notes, markdown, mcp]
timestamp: 2026-08-16
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 4
needs-human: true
---

# Use Markdown for note content

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> because the same canonical content must round-trip without loss through both the React editor and MCP agent tools, is a note an explicit plain-text title plus Markdown body, or a structured rich-text/block document like Notion?

A structured block model would widen storage, editor, API, and agent complexity before the feature proves a need for blocks.

## Decision

Store an explicit plain-text title and a Markdown body. Preserve both fields unchanged across the dashboard, REST, and MCP.

## Consequences

Agents and people share a simple lossless format. Rich block semantics and Notion-compatible structured documents remain out of scope.
