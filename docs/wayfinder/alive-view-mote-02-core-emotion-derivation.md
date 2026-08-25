---
type: wayfinder-plan
title: Alive View 02 — core emotion derivation
description: A pure, deterministic derivation from family transcripts to emotion word and trigger line, unit-tested in the claude core.
tags: [wayfinder, core, sessions, live]
timestamp: 2026-08-25
scope: claude
campaign: alive-view-mote
number: "02"
---

# Alive View 02 — core emotion derivation

Branch: `task/alive-view-mote-02-core-emotion-derivation`, cut from `wayfinder/alive-view-mote`.
Status: done · 2026-08-25
Lane: `stacks/claude/core/src/` (one new domain file plus its export line in `index.ts`) and that package's tests. Touch nothing under any admin app.

## Criteria

1. New pure module in `stacks/claude/core/src/`, exported from `index.ts`. Input: the family transcripts shape `getSessionGraphNodes` returns (each thread's merged node stream plus its transcript-level `modified`), and an injected `now: number` — no clock, no environment, no network reads; the core stays deterministic.
2. Derivation per ADRs 0018/0019/0022/0023/0024/0026: pick the newest-`modified` transcript; run `mergeSessionNodes` over its two arrays if not already merged by the caller; take the LAST node's state:
   - `done` → Smiling; `error` → Disgruntled; `task`/`tool`/`decision` → Thinking; no nodes → Smiling.
   - An interrupted last node maps to Smiling regardless of type and never ages into stress.
   - Stressed replaces Thinking when `now - Date.parse(newestModified) > STRESS_THRESHOLD_MS` (30 minutes, named constant). Finished, errored and interrupted states never age into stress.
3. Trigger-line text builder with two grammars: general "<emotion> · step <index> · <age> ago" for non-stressed states (tool nodes "tool · <Tool>(<first arg>)"; decision/done ~80 chars of text; error "error · <tool> failed", or the node's own text truncated when `tool` is null); stressed renders only "idle for Xm"; interrupted renders "stopped · step <index> · <age> ago" with text like done. Age is last-append age against the newest `modified`.
4. Vitest unit tests beside the module covering: each node type mapping, interrupted terminality, the 30-minute boundary (just inside/outside), finished/errored never aging, toolless error fallback, truncation at ~80 chars, empty-family and empty-node inputs, newest-transcript selection during fan-out.
5. Core keeps zero runtime dependencies and imports carry explicit `.ts` extensions.

## Verification

`pnpm --filter @agent-proxy/claude-core test` green; repo-wide typecheck and `biome check` green via `my-command-tools verify`.
