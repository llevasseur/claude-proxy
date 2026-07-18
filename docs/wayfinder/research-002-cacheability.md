# Research 002 — Which requests are safe to serve (cacheability gate)

Read-only analysis for [ticket 002](tickets/002-cacheability-gate.md) of
[map-proxy-skim](map-proxy-skim.md). Characterizes real Claude Code traffic
against the three cacheability gates (**determinism**, **statelessness**,
**recurrence**) and feeds the key/invalidation policy in
[ticket 003](tickets/003-key-and-invalidation.md).

## Corpus

- **Source:** `logs/**/*.request.txt` + sibling `*.audit.json` (the gitignored
  audit corpus in the main checkout). Read-only; nothing copied or committed.
- **Size at snapshot:** 1810 `*.request.txt` files — **1787 non-empty** request
  bodies plus 23 zero-byte files (aborted/pre-flight; excluded from all rates).
  `logs/archive/` holds 967; the day-1 (`2026-07-18`) top level holds 843.
- **Window:** `2026-07-13T23:50:57Z` → `2026-07-18T22:41:01Z` (~5 days).
- **Endpoint:** 100% `POST /v1/messages?beta=true`.
- **Status:** 200 ×1716, 429 ×71 (rate-limit), 404 ×23.
- **Models:** `claude-opus-4-8` ×1220, `claude-sonnet-5` ×556,
  `claude-haiku-4-5` ×11.
- **Streaming:** `stream:true` ×1179, `stream` absent ×608.
- **`max_tokens` (request-type proxy):** 64000 ×1168 (main agent turns),
  64 ×446 (classifier/labeler jobs), 1 ×65 (`quota` pings), 1024 ×46, 32 ×29,
  8192 ×22, 32000 ×11.

**Honesty caveat — the corpus is small and single-device.** `device_id` is
constant across all 1787 bodies (one machine, one user). So these numbers are a
*floor* for recurrence within one developer's own traffic; they cannot measure
the cross-session / cross-user sharing that the map names as the skim's real
payoff. The capture is also live-growing (counts drift by a few files between
reads). Treat every fraction below as "at least this, on one device."

## Q1 — Byte-exact repeat fraction (the exact-match hit-rate floor)

Keyed exactly as `sha256(rawBody)` — the same key `skim.mjs` uses.

| Slice | Requests | Distinct bodies | Redundant repeats (hit floor) | Floor % |
|---|---|---|---|---|
| Full corpus (non-empty) | 1787 | 1768 | 19 | **1.1%** |
| Today only (2026-07-18) | 820 | 807 | 13 | 1.6% |
| **Gated: `stream:true` /v1/messages** (what ticket 001 actually caches) | 1179 | 1172 | **7** | **0.6%** |

Only **11 hashes** repeat at all; the largest byte-exact group is ×5. The
exact-match skim's real addressable hit-rate on this traffic is **~1%, and ~0.6%
for the streamed subset it can replay.** That is the honest floor: on a single
developer's own workload, byte-exact repeats are rare.

The reason is Q3: every body carries per-session identifiers and live
environment blocks, so even a request that is *semantically* a repeat almost
never hashes the same.

## Q2 — Shapes that recur but are NOT byte-identical (semantic-layer candidates)

Clustering by a volatility-stripped signature (`model` + `max_tokens` +
leading system text + first user-instruction line) yields **63 clusters covering
1769 of 1787 requests** — i.e. almost all traffic is one of a few dozen recurring
*shapes*, yet within each cluster distinct-hash count ≈ member count (near-zero
byte reuse). Top clusters:

| Members | Distinct bodies | Shape |
|---|---|---|
| 199 | 189 | `mt=64` sonnet-5 — "The following is the user's CLAUDE.md configuration…" (safety/config classifier) |
| 160 | 160 | `mt=64000` opus-4-8 — main agent turn (`<system-reminder>` + gitStatus) |
| 120 | 120 | `mt=64000` opus-4-8 — main agent turn |
| 102 | 101 | `mt=64` sonnet-5 — CLAUDE.md classifier |
| 88 | 88 | `mt=64` opus-4-8 — CLAUDE.md classifier |
| 50 | 49 | `mt=1` opus-4-8 — `"quota"` ping |

Two tiers of candidate:

1. **Small, stateless utility calls — the realistic semantic target.** The
   `mt=64` CLAUDE.md-config classifier, the `mt=64` "2-4 word lowercase label for
   this job" title generator, and the `mt=1` `"quota"` ping recur hundreds of
   times, are short, and are near-deterministic. Their bodies differ *only* in
   volatile fields (see Q3), so normalizing those away would collapse each
   cluster to a handful of keys — a real hit-rate, not the 1% floor.
2. **`mt=64000` main agent turns — high volume, near-zero cacheability.** 160 /
   120 / 96 … per cluster, but distinct == count. Each turn embeds live
   `tool_result` output, the current `gitStatus`, and a growing conversation
   prefix, so no two are alike and none *should* be served from a semantic match
   (statelessness gate fails — see Q3). These are the volume, but not the prize.

## Q3 — Volatile signals a naive cache would serve stale (what the key must exclude/scope)

Substring presence across the 1787 non-empty bodies:

| Signal | Bodies | % | Gate implication |
|---|---|---|---|
| `session_id` | 1787 | 100% | **Exclude** — rotates per session; answer-irrelevant |
| `device_id` / `account_uuid` | 1787 | 100% | **Exclude** — identity, not content |
| git HEAD / branch | ~1723 | 96.4% | **Scope or refuse** — answer can depend on live HEAD |
| `cache_control` | ~1705 | 94.6% | Ignore for keying (Anthropic prefix-cache breakpoints) |
| cwd / working directory | ~1662 | 92.2% | **Scope** — answer can depend on it |
| gitStatus block | ~1633 | 90.6% | **Scope or refuse** — live repo state |
| "Today's date" / date line | ~1209 | 67.1% | **Exclude from key + TTL** — time-sensitive answer |
| `system-reminder` | ~1205 | 66.9% | Contains the date/env blocks above |
| env/platform block (`Platform:`/`OS Version:`) | ~1191 | 66.1% | **Scope** — host-dependent |
| `tool_result` / `tool_use` | ~1101 | 61.1% | **Refuse** — embeds live file/command output |
| ISO timestamp in body | ~587 | 32.6% | **Exclude from key + TTL** |

**Smoking gun.** Two `"quota"` pings that are otherwise byte-identical diverge at
exactly one place — the `session_id` inside `metadata.user_id`:

```
A: …"session_id":"6d046d49-8344-4271-b086-01372df4fdcc"}"}}
B: …"session_id":"4e14f13a-253e-499c-acf5-40d8fca33374"}"}}
```

Of 65 `quota` pings, 49 are "distinct" — the sole cause of variance is a rotating
UUID that has zero bearing on the answer. This single field is why the byte-exact
floor is ~1% instead of much higher, and it is the first thing a real key must
strip.

### What this means for the key (input to ticket 003)

- **Exclude from the key** (answer-irrelevant volatility): `metadata.user_id`
  (`session_id`, `device_id`, `account_uuid`), embedded clock / "Today's date" /
  ISO timestamps, and `cache_control` breakpoints. Stripping just these unlocks
  the utility-call clusters in Q2.
- **Scope the key** (answer *depends* on it, so it must be part of the key, not
  stripped): `cwd`, host/platform block, and git branch/HEAD where the request
  reasons about the repo.
- **Refuse to cache** (statelessness gate fails outright): any body carrying
  `tool_result` content or a live `gitStatus` block — the answer is a function of
  live disk/VCS state that the key cannot faithfully capture. This is ~61%+ of
  traffic and essentially all `mt=64000` agent turns, which is why exact-match
  (ticket 001) is the correct conservative floor for streamed turns and why the
  semantic layer should target the small stateless utility calls first.
- **TTL still required** even after excluding the clock: date-sensitive answers
  must expire (ticket 001's `SKIM_TTL_MS`, default 1h, is a reasonable start).

## Bottom line

On real single-device Claude Code traffic, the **exact-match skim floor is ~1%
(0.6% for the streamed subset it caches)** — near-zero, because every request is
salted with a per-session UUID and stamped with live git/date/tool state. But
**~99% of requests fall into ~63 recurring shapes**, and the gap between "same
shape" and "same bytes" is almost entirely the volatile fields catalogued in Q3.
The payoff path is therefore: (1) a normalized key that excludes session/clock
identity and scopes on cwd/HEAD, aimed at the **small stateless utility calls**
(quota ping, CLAUDE.md-config classifier, title/label jobs); and (2) an explicit
**refuse-to-cache gate** on `tool_result` / live-`gitStatus` bodies so the cache
never serves an answer that depended on state it didn't key on. Whether the
semantic layer clears the wrong-answer bar is ticket 003 + 004's call; this
research says the *addressable* set exists but is the utility tail, not the
64k-token agent turns.
