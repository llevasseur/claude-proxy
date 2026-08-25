---
type: adr
title: The emotion word is the live region
description: aria-live sits on the emotion word alone; the trigger line stays outside any live region.
tags: [dashboard, accessibility, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0027"
    file: docs/adrs/0027-the-emotion-word-is-the-live-region.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 10
needs-human: false
---

# The emotion word is the live region

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> Should the emotion word and trigger line announce themselves to screen readers, or stay silent under the recorded reasoning that streaming re-announcements are noise rather than access?

`docs/features/dashboard-chat-sessions.md` already recorded that a live region over streaming content re-announces churn on every append. Silence, though, would hide the one unattended transition worth hearing.

## Decision

Put `aria-live="polite"` on the element holding only the emotion word. During an active run the word holds steady at Thinking across appends, so nothing announces until the word itself changes — finished, errored, stopped, or stale to Stressed. The trigger line is ordinary text outside any live region.

## Consequences

Non-visual operators hear exactly the signal the view exists for and none of the per-append churn.
