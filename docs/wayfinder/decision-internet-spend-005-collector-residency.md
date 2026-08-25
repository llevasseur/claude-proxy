---
type: decision
title: "Decision internet-spend 005 — The collector is a timer inside net-server; LaunchAgent out of scope"
description: Where the hourly wake lives, the fourth zellij layout, and the deployment story left to the operator.
label: wayfinder:decision
map: map-internet-spend
status: proposed
timestamp: 2026-08-25
decided-by: /dev
ratified: false
wayfinder: internet-spend
grill-round: 5
needs-human: true
---

# Decision internet-spend 005 — The collector is a timer inside net-server; LaunchAgent out of scope

> **Status: proposed — NOT ratified by a human.** Proposed by the `/dev`
> workflow running unattended. Whether this Mac should have a launchd-owned
> collector is the operator's call, not an unattended run's.

## Context

The griller's question, verbatim in part:

> Question 5 of ~8 — who wakes the collector up, and is "the server wasn't running" allowed as an answer to "why is this chart empty"? … data exists only while the operator has that zellij session open … no way to distinguish "machine was off" from "you never started the collector" … A LaunchAgent / launchd plist collecting independent of any dev session — real coverage, but a new always-on component on the user's machine, installed outside anything the repo currently does …

## Decision

1. The hourly timer lives INSIDE the net-server process — one process, one
   database, single writer.
2. A fourth zellij layout IS in scope: `.zellij/net-server.kdl` following the
   sibling layouts' shape, plus `stacks/net/scripts/zellij.sh` resolving the
   repository top level like its siblings'. This touches no existing layout and
   no existing package.
3. LaunchAgent is explicitly OUT of scope. This repository installs no
   always-on machine-side components; the limitation (data exists only while
   net-server runs) is DOCUMENTED — AGENTS.md stack-table row and a note on the
   /internet page's collector-status line — rather than hidden behind an
   installer this run chose unilaterally.
4. Coverage legibility: `/api/summary` carries `lastSampleAt` and per-day sample
   counts; the page renders "last sample N ago" so sparse corpora read as
   sparseness. Combined with decision 002's known-quiet split, absence of
   evidence never renders as evidence of quiescence.
