---
type: feature
title: Keep a chat warm
description: A registered session's previous request is re-sent with max_tokens 0 on a padded timer, so its prompt cache entry is refreshed by a cache read instead of expiring — capped at 8 hours, and measured to fire below its own break-even.
tags: [proxy, cache, usage-limits, session]
timestamp: 2026-09-15
scope: claude
---

# Keep a chat warm

## Summary

A session registers with the proxy at `POST /__warm`. From then on, whenever that session
has been quiet for about 83% of its cached prefix's TTL — roughly 50 minutes against the
`1h` TTL every observed request carries — the proxy re-sends that session's **previous
forwarded request** with `max_tokens: 0`. The upstream reads the cached prefix and answers
nothing, which refreshes the cache entry's timer. The registration is capped at **8
hours**, and any of eight stop conditions ends it earlier.

Register with `/warm`. Read what it spent with `cat logs/warm.json`.

**The feature's own premise is measured, and the measurement does not support the shipped
default.** That is in [Motivation](#motivation) rather than a footnote, because a reader
deciding whether to use this needs it before the instructions, not after.

## Motivation

### A cache read is roughly 5.5x cheaper than the cold write it avoids

The unit is `usageUnits`, not dollars. This account meters on a subscription, where the
binding constraint is the 5-hour window and the weekly cap, so per-token list-price
arithmetic prices a currency the account never spends —
[ADR 0073](../adrs/0073-keep-alive-is-justified-in-usage-units.md) is why the justification
is stated this way. `CACHE_READ_METERING_WEIGHT` in
[`stacks/claude/core/src/usage-limits.ts`](../../stacks/claude/core/src/usage-limits.ts) is
`0.02`, and:

    usageUnits(t) = t.input + t.output + t.cacheCreation + t.cacheRead * 0.02

On a 200,000-token prefix:

| Event | Tokens | Weight | usageUnits |
|---|---|---|---|
| One keep-alive ping | 200,000 cache read | 0.02 | 4,000 |
| Nine pings across a full 8-hour window | — | — | 36,000 |
| The cold write it avoids | 200,000 cache creation | 1.0 | 200,000 |

So a whole 8-hour window of pings costs about **5.5x less** than one cold re-write of the
same prefix. The margin survives the weight's own stated uncertainty: the source file holds
`0.02` loosely, with plausible values spanning 0.011–0.023, and at the pessimistic end nine
pings cost 41,400 units — still under a quarter of one cold write.

That is the entire case for the feature, and it is conditional on one thing: **the user
coming back.**

### The base rate is 9.6%. Break-even is 15.5%.

They do not come back often enough. Measured over one archived day, keyed on
`session.sessionId`, with a cache-expiring gap defined as 60 minutes of silence:

    distinct sessions 52 · requests 3,291
    went quiet >60 min and then produced another request:  5  (9.6%)
    session lifetime (first→last), minutes: p50 9.9 · p90 110.2 · max 214.9
    sessions with exactly one request: 9

Break-even follows from the table above: a hit saves 196,000 units, a miss at `hours=8`
spends 36,000, so registration pays only when it hits more often than
`36,000 / 232,000` = **15.5%** of the time.

**9.6% measured against a 15.5% break-even.** Registering every session at 8 hours is net
negative by roughly 3x. And the honest rate is lower still than 9.6%: of the five resume
events, two produced a single trailing request and are worth nothing, which puts the real
band at **5.8%–9.6%**.

Two further facts from the same day, both of which cut against the shipped default:

- **Median session lifetime was 9.9 minutes.** The typical session is over long before a
  single ping would fire at ~50 minutes.
- **No session in the corpus lived past 3.6 hours** (max 214.9 minutes). The 8-hour cap was
  not merely unsupported by this evidence — it was never exercised by it.

The deadline is the lever, because it sets what a miss costs:

| hours | pings on a miss | miss cost | break-even |
|---|---|---|---|
| 8 | 9 | −36,000 | 15.5% — below the base rate, loses |
| 4 | 5 | −20,000 | 9.3% — marginal |
| 2 | 2 | −8,000 | 3.9% — pays even under blanket registration |

**The 8-hour default ships anyway**, because the user specified it explicitly and twice,
and a measurement is evidence rather than authority.
[ADR 0078](../adrs/0078-resume-rate-is-below-break-even.md) carries the full table, the
five resume events individually, and two recommendations for a human: move registration to
the moment of stepping away rather than session start, and drop the default to 2 hours
while keeping 8 as an opt-in ceiling.

### What that sample cannot tell you

Every number above comes from **one account, one working day, with capture ending 20:30**.
Three limits follow, and they are load-bearing rather than boilerplate:

- Long away-stretches are **right-censored** by the 20:30 cutoff — a session that resumed
  the next morning reads as one that never resumed.
- There is **no overnight away-stretch in the sample at all**, which is the headline use
  case. The evening-to-morning gap this feature exists to serve is exactly the gap the
  measurement could not see.
- It is one account's working rhythm, not a population.

This is why `warm.json` records a terminal `outcome` per entry. After a week of real use
the hit rate is measurable against the 15.5% line from the user's own traffic, and nobody
has to take one archived day's word for it.

## Behavior

### Registering is a handshake, not an assertion

`POST /__warm` creates a **pending** entry. It becomes **armed** only when a real forwarded
request matches its `sessionId` against either the `x-claude-code-session-id` header or
`metadata.user_id.session_id`. **A registration unmatched after two minutes expires with
the reason recorded.**

The handshake exists because one link is unverified. The header id and the metadata id were
measured equal across 3,291 requests with zero disagreement and no one-sided case — but
`CLAUDE_CODE_SESSION_ID`, the environment variable `/warm` actually sends, is a third
string that has never been joined to either.
[ADR 0075](../adrs/0075-registration-stays-pending-until-matched.md) records the attempt to
close that gap and why it failed. So a registration that matches nothing reports that it
warmed nothing, rather than sitting silently warming nothing.

### The endpoint

`/__warm` is handled in `handle()` ahead of the skim gate and the upstream forward, and
takes three methods:

| Method | Body | Does |
|---|---|---|
| `POST` | `{sessionId, hours}` | registers; `hours` clamped to a maximum of 8 |
| `DELETE` | — | cancels the registration |
| `GET` | — | lists current entries |

**It is bound to 127.0.0.1 only**, and rejects a non-loopback caller whatever `HOST` is set
to. The proxy can be bound to all interfaces with `HOST=""`; this endpoint does not follow
it out. Replies are JSON and never echo a stored body.

### The ping

A ping is the stored forwarded body re-sent with `max_tokens: 0`, which is an
`invalid_request_error` in combination with `stream: true`, `thinking.type: "enabled"`,
`output_config.format`, or a forced `tool_choice`. Exactly those are removed and **nothing
else changes** — every other byte has to survive or the cached prefix stops matching. A
non-forced `tool_choice: {"type":"auto"}` is left alone.

The TTL is read off the `cache_control` already on the stored body rather than hardcoded,
so a client-side TTL change carries through without a proxy edit. One timer sweeps the
whole registry, `unref()`-ed so it never holds the process open.

**The ping issues its own `https.request` and never enters `handle()`.** That one choice is
what keeps it out of the skim cache, `appendSession`, `auditRequest`, `recordPrompt`,
`writeAuditSidecar` and `noteCacheRead` at once — a path that never acquires those side
effects cannot forget to skip one, which is why
[ADR 0077](../adrs/0077-a-ping-never-enters-handle.md) rejected an enumerated skip list.
`noteCacheRead` is the sharpest case: feeding it a cache read the proxy manufactured would
mark the session warm on the proxy's own evidence, and that flag gates breakpoint
injection.

**The bearer is taken fresh, never from the entry.** A warm entry is defined by the absence
of traffic, so its captured credential ages with nothing to refresh it. The ping takes the
newest bearer observed for the **same `account_uuid`** at send time, with no cross-account
fallback ever; with no bearer held for that account the ping does not fire and the entry
records why. [ADR 0076](../adrs/0076-ping-takes-the-freshest-same-account-bearer.md) carries
the gap measurement behind it — on that same single day the account never went quiet longer
than 29.2 minutes against a 50-minute ping interval.

**The window may cross local midnight.** The date string Claude Code shows the model sits at
`messages[0]`, not in the cached `system` blocks, and message 0 is never rewritten — so at
T+8h it is stale but byte-identical, and a cache match is a byte comparison.
[ADR 0074](../adrs/0074-cached-prefix-survives-local-midnight.md) measured that on one
request from one client version (`claude-cli/2.1.222`) and says so; re-measure before
trusting it across a client upgrade.

### Stop conditions

Each records a distinct reason:

- the hard 8-hour deadline;
- a real request arriving — `lastActivity` resets and the ping is skipped;
- two consecutive ping failures;
- a 429 or 529;
- **401 or 403, named and reported separately** — a credential expiry is a different event
  from an upstream wobble, and folding it into the generic failure counter is the silent
  failure [ADR 0076](../adrs/0076-ping-takes-the-freshest-same-account-bearer.md) exists to
  prevent;
- usage-limit utilization above a threshold, read from `usage-live.json` — Anthropic's own
  meter, which already counts the pings, and deliberately **not** the local sidecar corpus;
- proxy restart, which self-clears because the registry is memory-only.

### The ledger

`logs/warm.json` mirrors status into `LOG_DIR` in the shape of `usage-live.json` — built,
written to a `.tmp` sibling, then renamed into place, which also wakes the server's existing
log-directory SSE watcher. Per entry and in aggregate it carries the session key, `state`,
`pingsSent`, cumulative cache-read tokens, `usageUnits` spent, the deadline, and a terminal
`outcome` of `resumed`, `expired`, or `stopped-<reason>`.

**Status only — no body, no prompt, no credential.** The credential stays in memory and dies
with the process.

The repo's own derived analytics — SQLite, cost and context-size analytics, the daily
summary — will sit below Anthropic's utilization by exactly the ping spend, because no ping
enters the audit corpus. That gap is real, and this file is what makes it legible.

## Using it

`/warm` is one curl and registers the current session for 8 hours:

```bash
curl -s -XPOST http://127.0.0.1:${CLAUDE_PROXY_PORT:-8787}/__warm \
  -d "{\"sessionId\":\"$CLAUDE_CODE_SESSION_ID\",\"hours\":8}"
```

It reports that the registration is **pending** — not that anything is being kept warm,
which is only true once a real request arms it. A command that claims otherwise is the
failure the handshake exists to catch.

**Register when you actually step away, not at session start.** At session start neither
you nor the agent knows yet whether the session will be paused or simply finished, and the
finished case is the one that spends the most for nothing. This is guidance in the text
rather than enforced behaviour; see
[ADR 0078](../adrs/0078-resume-rate-is-below-break-even.md).

## What it deliberately does not do

- **No admin route, card, or API endpoint.** `warm.json` is written in `usage-live.json`'s
  shape so a card can be added later without touching the proxy again, and that is all this
  campaign ships — [ADR 0079](../adrs/0079-warm-json-ships-without-a-dashboard-card.md)
  records that as a scope call made on the user's behalf, including the risk that a human
  who wanted a card did not get one.
- **No change to the audit sidecar schema**, and no typed origin field on it. A ping is
  proxy-originated traffic recorded in the proxy's own status file, never in the corpus
  `AGENTS.md` names the source of truth for what the client sent —
  [ADR 0077](../adrs/0077-a-ping-never-enters-handle.md) §3.
- **Nothing persisted but status.** No body, no prompt, no credential reaches disk.

## Related

- [ADR 0073 — Justify the keep-alive in subscription usage units, not dollars](../adrs/0073-keep-alive-is-justified-in-usage-units.md)
- [ADR 0074 — The cached prefix survives local midnight](../adrs/0074-cached-prefix-survives-local-midnight.md)
- [ADR 0075 — A warm registration stays pending until a real request matches it](../adrs/0075-registration-stays-pending-until-matched.md)
- [ADR 0076 — A keep-alive ping takes the freshest same-account bearer](../adrs/0076-ping-takes-the-freshest-same-account-bearer.md)
- [ADR 0077 — A keep-alive ping never enters handle](../adrs/0077-a-ping-never-enters-handle.md)
- [ADR 0078 — The measured resume rate is below break-even](../adrs/0078-resume-rate-is-below-break-even.md)
- [ADR 0079 — warm.json ships without a dashboard card](../adrs/0079-warm-json-ships-without-a-dashboard-card.md)
- [Usage limit meters](usage-limit-meters.md)
