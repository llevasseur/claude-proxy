---
type: adr
title: Agent patterns match by case-insensitive substring
description: How agentPatterns classify process names for the approximate share series.
tags: [net, agents, classification]
timestamp: 2026-08-25
scope: net
decided-by: /dev
ratified: false
wayfinder: internet-spend
grill-round: 6
needs-human: false
---

# Agent patterns match by case-insensitive substring

> **Status: proposed — NOT ratified by a human.** Proposed by the `/dev`
> workflow running unattended.

## Context

The griller's question, verbatim in part:

> Question 6 of ~8 — what exactly matches an entry in `agentPatterns`, given what process names actually look like? … real agent traffic on this Mac does **not** arrive under clean names … `Claude Helper (Renderer)` … the `node` false-positive wall … is the match **exact case-sensitive equality**, **case-insensitive prefix**, or **substring** — and do you want helper-process names (`* Helper *`) addressed in the default list at all…?

## Decision

1. Case-insensitive SUBSTRING match, applied to the process name after
   stripping nettop's trailing `.pid` suffix (`launchd.1` → `launchd`).
2. Reasons: the scope labels the series approximate, so recall is what makes it
   useful; substring catches Electron helper names with no extra entries; the
   node false-positive wall is inherent to name-based attribution (those
   processes' name is literally `node` and they match identically under exact
   equality) and is answered by labeling, not by matching harder; classification
   is read-time over stored raw names, so a wrong default re-slices when edited.
3. The page labels the series as approximate, attributed by process name.
4. The default list stays verbatim from scope:
   `["node","claude","Claude","codex","ox"]` — redundant under
   case-insensitivity, kept because the scope wrote it.
5. `PUT /api/config` accepts arbitrary patterns so the operator can tighten to
   exact strings if substring proves noisy.
