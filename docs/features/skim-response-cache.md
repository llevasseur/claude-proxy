---
type: feature
title: Skim response cache
description: An opt-in, byte-exact response cache in the proxy that replays a repeat streamed /v1/messages reply from disk with zero upstream call, plus a dashboard page measuring hit-rate and dollars saved.
tags: [backend, dashboard, usage]
timestamp: 2026-08-02
---

# Skim response cache

## Summary

An opt-in, byte-exact proxy **response** cache. A streamed `POST /v1/messages`
whose bytes match a prior body replays its stored SSE with **zero** Anthropic API call,
saving input, output, and latency. Every request records a `skim` audit-sidecar
block; the [dashboard](admin-dashboard-for-claude-proxy-usage.md) aggregates hit rate
and estimated savings. It is **off by default** unless `SKIM_CACHE` is set. See
[map-proxy-skim](../wayfinder/map-proxy-skim.md).

## Motivation

Anthropic's **prefix cache** is server-side transformer KV-state on its GPUs that saves
~90% of *input* tokens and cannot move into the proxy without self-hosting. The skim is an
**app-layer response cache**: it caches output, skips the whole request, and works
cross-session.

[Cacheability research](../wayfinder/research-002-cacheability.md) measured 1,787
bodies: byte-exact hits were **~1.1% overall and ~0.6% for replayable streamed
traffic** because session UUIDs, git status, dates, and `tool_result` output salt
requests. Yet ~99% fall into ~63 recurring shapes. Byte-exact keying is the safe
floor; instrumentation determines whether a smarter key is worthwhile.

## Behavior

- **Off by default** — `proxy/skim.ts` reads `SKIM_CACHE` once at startup and only treats
  `1`, `true`, `yes`, or `on` (case-insensitive) as enabled. Unset means `cacheable()`
  returns `false` for everything: nothing stored, nothing served.
- **Env vars** — `SKIM_CACHE` (enable flag, default off), `SKIM_TTL_MS` (entry lifetime,
  default `3600000` = 1 hour), `SKIM_MAX_ENTRIES` (how many entries the directory may hold,
  default `2000`; junk or a non-positive value falls back to that default),
  `SKIM_DIR` (cache directory, default `<LOG_DIR>/../.skim-cache`,
  a sibling of the logs dir). Zero runtime dependencies — Node built-ins only.
- **The gate** — `cacheable()` admits a request only when all three hold: the skim is
  enabled, the path contains `/v1/messages`, and the parsed body has `stream === true`
  (replay can only re-emit raw SSE, so non-streaming replies are never cached).
  `proxy.ts` separately excludes `count_tokens` via `isTokenCount` before calling the gate.
- **Cache key** — `sha256` of the exact forwarded request body (`keyFor(rawBody)`), taken
  *after* the proxy's own tool/reminder stripping so the key matches what was actually sent.
  The model is inside the body, so it is part of the key by construction. Any one-byte
  difference is a different key, hence a miss.
- **On disk** — two files per entry in the cache directory: `<key>.sse` (the raw response
  bytes) and `<key>.meta.json` (`statusCode`, `contentType`, `inputTokens`, `model`,
  `storedAt`). Writes are best-effort — a failed write is swallowed so it can never break
  the proxy.
- **TTL is a read-time check** — `lookup()` returns `null` when `Date.now() - storedAt`
  exceeds the TTL, and an expired entry is treated as an ordinary miss: the request goes
  upstream and the entry is only replaced if that identical key recurs. Whether the file
  is still on disk at that point is the write path's business, below.
- **The directory is bounded on write, never by a sweeper** — `evict()` runs at the end of
  every `store()` and nowhere else, so the read path (on every request) is untouched and the
  cost falls on the write path (only on a miss, which is already writing a response body).
  It is one `readdir` of the cache's own directory followed by three passes: a `.meta.json`
  whose `.sse` is gone is deleted (it can never be served), anything past `SKIM_TTL_MS` is
  deleted, and the oldest of whatever survives is deleted until the count is within
  `SKIM_MAX_ENTRIES`. The entry `store()` just wrote is always kept. There is deliberately no
  timer, no background process, and no index file: `proxy/` has zero runtime dependencies and
  no build, so a sweeper is the wrong shape for it.
- **Eviction is LRU, and mtime is the whole index** — `lookup()` touches the `.sse` file's
  mtime on a hit, which is one syscall on a path that was reading that file anyway, so
  recency is recorded with nothing to keep in sync. `evict()` then orders on mtime, which
  makes it least-recently-*used* rather than oldest-written; decision 004 left the choice
  between the two open, and this settles it on the mechanism rather than a preference.
  Expiry is judged on mtime too, and that is deliberately conservative: mtime is set at write
  and only ever moved forward by a hit, so it is always ≥ `storedAt`, and an entry stale by
  mtime is necessarily stale by `storedAt` — eviction can therefore never delete something
  `lookup()` would still have served. The alternative, reading and parsing every sidecar per
  write, buys only that an entry which expired just after its last hit is reclaimed one pass
  sooner. Every step is best-effort per decision 004's "fail safe, not loud": a failed
  `readdir`, `stat`, or `unlink` leaves the file in place rather than disturbing the request.
- **Hit path: zero upstream call** — the proxy writes the stored status and content-type,
  ends the response with the stored bytes, and returns *before* any `https.request` is
  made. It still writes the full log set (`.request.txt`, `.md`, `.audit.json`) and appends
  to the session transcript, then logs
  `[agent-proxy] SKIM HIT <first 8 of key> · saved ~N input tok · logs/<base>.md`.
- **Miss path stores only clean successes** — on the normal pass-through, `skim.store()`
  runs only when the request was cacheable *and* the upstream status was exactly `200`.
  A miss changes nothing about the bytes Claude Code receives.
- **Sidecar instrumentation on every request** — `writeAuditSidecar` always emits a `skim`
  block with exactly four fields: `enabled`, `servedFromCache`, `savedInputTokens`, and
  `cacheKey` (`null` when the request wasn't cacheable). Legacy or malformed blocks are
  normalized to an all-off default in `packages/core`, so old sidecars count as
  skim-disabled traffic.
- **Aggregation** (`packages/core/src/skim.ts`) — `computeSkimDigest` walks a day's
  sidecars and produces `requestCount`, `enabledRequests`, `hits`, `misses`, `hitRate`
  (hits ÷ enabled requests, `0` with no enabled traffic — disabled requests stay out of the
  denominator), `savedInputTokens`, `estSavedUsd`, and `topShapes`. Dollars saved are
  estimated per hit as `savedInputTokens / 1e6 × priceFor(model).input` — the sidecar's own
  model at that model's **input**-token rate, a conservative floor that ignores the output
  tokens a hit also avoids. `skimDigestsByDay` buckets by the dashboard's shared reporting
  zone (`America/New_York`, EST/EDT), oldest first, so Skim and the Overview/Trends windows
  roll over together at Eastern midnight.
- **Shapes** — any request with a `cacheKey` accumulates into a per-key `SkimShape`
  (`requests`, `hits`, `savedInputTokens`, `estSavedUsd`, plus a `requestText` label),
  ranked by request count. `requestText` is **not** a sidecar field: `server/src/logs.ts`
  enriches each sidecar with `skimRequestText` under the `includeSkimRequests` flag by
  reading the sibling `.request.txt` and extracting the latest user text, so a key with no
  surviving request log simply has no label.
- **Labels do not survive body eviction; the numbers do** — every count, token, and dollar
  on this page comes from the `.audit.json` sidecar, which
  [retention](retention-lifecycle.md) keeps forever, so nothing here changes when
  `pnpm --filter @agent-proxy/claude-server maintain` evicts a day's `.md` and `.request.txt` bodies past
  `RETENTION_DAYS` (default 30). Only the verbatim `requestText` label is lost. A missing body
  is indistinguishable from a body that was never captured, so the readers count it:
  `skimRequestText` reports `bodyPresent: false` and both endpoints surface the total as
  `meta.bodiesEvicted`, so an all-blank **Request** column reads as retention rather than as a
  capture bug.
- **Endpoints** — `GET /api/skim?date=YYYY-MM-DD` (one day, defaults to today; invalid
  dates are ignored) and `GET /api/skim/trend?days=N` (`N` defaults to 14 and is clamped to
  1–365; `all` — or the `0` the picker sends — reads every day on record instead, its floor
  taken from the oldest day the corpus holds). Both enable the request-text enrichment and
  both report `meta.bodiesEvicted`
  alongside `meta.files` and `meta.parseErrors`; `/api/skim` and the trend's cross-window
  `topShapes` request `topN: 50`, while the trend's per-day `digests` keep the default 12.
  Both read the **live** log directory only: neither has the archive fallback `/api/trends`
  has, so a day `maintain` has already moved into `logs/archive/<date>/` contributes nothing
  — see the open question below.
- **Skim page** (`/skim`) — a 7/14/30-day window selector and four stat tiles:
  **Hit rate (today)** (with `hits / enabled` underneath), **Saved today**,
  **Saved (Nd)**, and **Saved input tokens (today)**. Two charts follow —
  **Hit-rate over time** and **Cumulative $ saved** (a running sum of daily `estSavedUsd`)
  — then **Top repeated request shapes (Nd)** as a bar chart of the top 12 keys by request
  count, and a **By shape** table with columns **Cache key**, **Request**, **Requests**,
  **Hits**, **Saved tokens**, and **Est. saved**. The **Request** cell expands to the
  captured user text, or reads *"Request log unavailable"* when the log is gone. With no
  captured activity the page shows *"No skim activity captured in the last N days."*

Data path: `proxy/skim.ts` (gate, key, store, replay) → the `.audit.json` sidecar's
`skim` block → the `SidecarSource` seam (`server/src/db/source.ts`) →
`packages/core/src/skim.ts` (`computeSkimDigest` / `skimDigestsByDay`) →
`server` (`/api/skim`, `/api/skim/trend`) → `apps/admin` (the **Skim** page). Only the proxy
side touches live traffic; everything downstream is read-only over captured sidecars.
Both server routes read through the seam
([ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md)): by default the SQLite
substrate answers from its tables with no directory read, `DB_READS=0` reverts to the
original `logs/*.audit.json` scan, and `SHADOW_DB=1` re-runs each build against the other
backing to compare. The request-text enrichment is still a file read either way — it opens the
sibling `.request.txt` — which is why an evicted body costs the label and nothing else.

## Acceptance criteria

- [x] The skim is off unless `SKIM_CACHE` is truthy (`1|true|yes|on`); with it unset the
      proxy neither stores nor serves anything.
- [x] Only streamed `/v1/messages` requests are cacheable; `count_tokens` and non-streaming
      requests are excluded.
- [x] The cache key is `sha256` of the exact forwarded request body, so only a byte-identical
      repeat can hit.
- [x] A hit replays the stored SSE and returns before any upstream request is issued, logging
      `SKIM HIT` with the key prefix and the input tokens saved.
- [x] A miss leaves the proxy's bytes unchanged — the response is passed through untouched,
      and a failed cache write never breaks the request.
- [x] Entries are stored only for upstream `200`s, and an entry older than `SKIM_TTL_MS` is
      treated as a miss.
- [x] The cache directory is bounded: every `store()` deletes expired entries and orphaned
      sidecars, then trims the least-recently-used until at most `SKIM_MAX_ENTRIES` remain,
      keeping the entry it just wrote. A hit touches mtime, so recency is use order rather
      than write order, and eviction never removes an entry `lookup()` would still serve —
      all unit-tested in `proxy/skim.test.ts` (TTL expiry, the count cap, the mtime touch on
      a hit and its absence on a miss, orphaned sidecars, the just-written key, a junk
      `SKIM_MAX_ENTRIES`, and a missing directory).
- [x] Every audit sidecar carries a `skim` block with `enabled`, `servedFromCache`,
      `savedInputTokens`, and `cacheKey`; malformed and legacy blocks degrade to
      skim-disabled rather than aborting a digest.
- [x] `computeSkimDigest` reports hit-rate over enabled traffic only, sums saved input
      tokens, estimates dollars at each model's input rate, and ranks repeated shapes —
      all unit-tested in `packages/core/test/skim.test.ts` (empty input, hit/miss counting,
      disabled-request exclusion, dollar estimation, shape ranking, request-text retention,
      `topN`, malformed sidecars, and reporting-zone day splitting, including a
      late-evening request whose UTC date is already the next day).
- [x] `GET /api/skim` and `GET /api/skim/trend` serve the digests, and `/skim` charts
      hit-rate, cumulative dollars saved, and top repeated shapes.

## Open questions

- ~~**The 7/14/30-day window is live-day-only.**~~ **Resolved**, and narrower than recorded:
  `buildSkim` already routed through the per-day helper that reads `logs/archive/<date>/`, so
  only `buildSkimTrend` was affected. It now calls `readWindow` in `server/src/db/source.ts`,
  the one place the archived and live halves of a window are composed, so an archived day stays
  in the trend charts and the cross-window shape table.
- **The semantic skim layer is not built.** Matching "same or similar task" needs an
  embedding/similarity threshold, scope keys (cwd, host, git HEAD), and a policy for
  answer-irrelevant volatility (`session_id`, embedded dates, `cache_control`). Research
  favors small stateless utility calls—quota ping, CLAUDE.md classifier, title/label
  jobs—not 64k-token agent turns.
- ~~**`SKIM_MAX_ENTRIES` and eviction were proposed but never implemented.**~~ **Resolved**,
  and it settled the one thing
  [correctness guardrails](../wayfinder/decision-004-guardrails.md) left explicitly open.
  `evict()` runs on the write path, deleting expired entries and orphaned sidecars and then
  trimming to `SKIM_MAX_ENTRIES` — see **The directory is bounded on write** above. Eviction
  is **LRU** rather than oldest-first, because the read path already opens the entry it is
  checking, so touching mtime on a hit makes the filesystem the index; the decision doc
  ratified neither, and the mechanism rather than a preference is what chose. Two of that
  doc's numbers are still unratified: the default max entry count (2000 here, against its
  "a few thousand") and the default TTL, below.
- **The `tool_result` refusal is proposal-only.** Nothing in `cacheable()` inspects message
  content, so a request whose messages carry `tool_result` snapshots of now-changed state is
  cached and replayable like any other. Decision 004 names this the highest-value exclusion
  to add, alongside a stream-completeness check (a truncated-but-`200` SSE is currently
  stored as if whole) — and that whole decision doc is still `status: proposed`, awaiting
  human ratification.
- **Default TTL.** Decision 004 says 1 hour is too long when keys cannot distinguish
  stable from live-state questions and suggests ~5–15 minutes; the value is unratified.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Map: proxy skim](../wayfinder/map-proxy-skim.md)
- [Cacheability research](../wayfinder/research-002-cacheability.md)
- [Correctness guardrails](../wayfinder/decision-004-guardrails.md)
