---
type: feature
title: Usage limit meters
description: The Overview carries live meters for the 5-hour, weekly, and weekly-Fable allowances, each with a plain-language read on whether the current burn rate is sustainable.
tags: [dashboard, usage, rate-limits, sse, proxy]
timestamp: 2026-07-30
---

# Usage limit meters

## Summary

The Overview opens with a meter per metered allowance — the rolling **5-hour** window, the
**weekly** window, and, when it applies, the **weekly Fable** window — and each one carries a
sentence saying whether the current rate is comfortable, close to the ceiling, or on track to
run out early. The meters and the day's statistics both update while a session is running,
over Server-Sent Events, so the page reflects requests as the proxy captures them rather
than at the last reload.

The bar's colour tracks the *pace*, not the fill level. A bar can be nearly full and still be
fine late in a window, while a modest bar early on can already be a problem — so the tone
comes from where the rate is heading, and a faint extension of the bar marks the utilization
the current rate projects to by reset.

## Three sources, in order of preference

**Anthropic's own accounting, when available.** The proxy now records every
`anthropic-ratelimit-*` / `x-ratelimit-*` response header into the request's sidecar as
`rateLimit`, names lowercased and values verbatim. Those headers carry the real allowance and
the real reset instant, so a window sourced from them needs no configuration and is exact.
Headers are read from the *newest* captured request only — an older reading would understate
everything since.

Header names are matched by shape rather than against a fixed list: one segment names the
span (`5h`, `7d`/`week`), an optional one narrows it to a model family, and the last names the
field (`limit`, `remaining`, `used`, `utilization`, `reset`). A renamed or newly-added window
therefore reaches the dashboard without a proxy change. Reset values are accepted as an ISO
instant, epoch seconds, epoch milliseconds, or seconds-from-now.

**A configured ceiling, next.** Anthropic does not publish subscription quotas as token
counts, so there is deliberately **no built-in default ceiling** — nothing here is measured
against a number this repo invented. Set one to state the real allowance:

| Variable | Window |
|----------|--------|
| `USAGE_LIMIT_5H` | rolling 5-hour |
| `USAGE_LIMIT_WEEK` | weekly |
| `USAGE_LIMIT_WEEK_FABLE` | weekly, Fable requests only |

Values accept `_`/`,` separators and `k`/`m` suffixes (`2.5m`, `900k`). A configured ceiling
always wins over a learned one: it is a statement about the allowance, where the learned
figure is only a guess at its floor.

**A ceiling learned from history, otherwise.** Requiring an env var per device meant a fresh
checkout showed no meters at all, so a window with neither headers nor configuration falls
back to the busiest **completed** window on record. Only completed windows count — the one in
progress is still filling, and letting it set the bar would peg every meter at 100% — and only
windows the retained logs fully span, since a window starting before the oldest retained
request is a fragment, not a window.

This is a **lower bound on the allowance, never the allowance**. Anthropic never told us the
limit, so the most that can be said is "at least this much was possible". The error therefore
runs in one direction only: dividing by a ceiling that is too low makes utilization read too
*high*, so a learned meter overstates how close the account is to its limit and cannot invent
headroom that isn't there. The UI says so — the meter is marked `inferred`, the status chip
talks about records rather than limits (`Below record`, `New record`), and the blurb points at
the env var for anyone who knows the true ceiling.

A window kind with no traffic at all learns nothing rather than a ceiling of zero, which is
how the Fable meter stays absent on plans that never touch it.

### The unit

Both the estimate and its ceiling are in **weighted tokens**:

    input + output + cacheCreation + (cacheRead × 0.1)

Cache reads bill at roughly a tenth of fresh input, so they weigh a tenth here; counting them
at par would let a cache-heavy hour dwarf every real request. `input` is used rather than
`realInput` because `realInput` already sums input + cacheRead + cacheCreation and would
double-count. As a sense of scale, an active coding day on this device runs ~14M units per
5-hour window.

## Coverage — why an estimated weekly window reads low

`logs/` retains roughly the current day; older days are relocated by an external job into
`logs/archive/<date>/`, which keeps the full per-request sidecar triples. The live directory
alone therefore cannot see a whole weekly span, and a weekly window drawn from it would
silently under-report.

The archive is what makes a *learned* weekly ceiling possible at all, and reading weeks of it
is why that pass is cached rather than run per request.

Each estimated window reports `coverage`, the fraction of the window actually backed by
retained logs. Below 0.95 the meter is labelled `partial` in amber and the blurb says the real
figure is higher — so a reassuring number never stands unqualified on incomplete data. The
header path is always `coverage: 1`, since Anthropic counts the window itself.

## The pace read

The sustainable rate is spending the whole allowance over the whole window, so the projection
is `utilization / elapsed`, and `elapsed` follows from the reset instant — a window resetting
in 1h of 5h is 80% gone. Statuses:

| Status | When | Tone |
|--------|------|------|
| `safe` | projects under 80% by reset | `--good` |
| `on-pace` | projects 80–100% | `--signal` |
| `aggressive` | projects over 100% — runs out before reset | `--amber` |
| `exhausted` | allowance spent | `--coral` |

A trailing estimate has no reset to run up against — the window *is* the last N hours — so
`elapsed` is 1 and the projection is simply where it already sits. It also gets its own
vocabulary: passing a configured ceiling means the estimate exceeded a budget the operator
chose, **not** that Anthropic is refusing anything, and only the header path says requests
will be refused.

A learned ceiling gets a third vocabulary, weaker still. It can support no claim about the
actual limit, so `safe` reads as "below the busiest window on record" rather than "within
limits", and passing the bar is called new territory, not exhaustion — it means a new record,
not a refusal.

Two states are deliberately *not* shown as reassuring zeroes: a window with no headers, no
configured ceiling, and too little history to complete a window is omitted, and when no
requests were captured at all no estimated window is emitted, because a 0% meter would read as
"well within limits" when the truth is "nothing was observed".

## Where it lives

- `packages/core/src/usage-limits.ts` — header parsing, the weighted unit, coverage, the pace
  assessment, and `learnCeilings`. Pure; `buildUsageLimits(sidecars, { limits, learned, now })`
  takes an injected `now`, so every threshold is testable. `USAGE_LIMIT_ENV_SUFFIX` is the one
  source of truth for the env-var names, shared with the server so a blurb cannot name a
  variable the server doesn't read.
- `proxy/proxy.mjs` — `extractRateLimit` copies only `anthropic-ratelimit-*` / `x-ratelimit-*`
  names off the upstream response, so no auth can ride along. The field is omitted entirely
  when upstream sent none, and a skim-cache-served request records none because no upstream
  call happened.
- `server/src/usage-config.ts` — resolves the configured ceilings from the environment.
- `server/src/usage-history.ts` — reads 28 days of live plus archived sidecars and learns the
  fallback ceilings from them. Four weeks leaves room for three completed weekly windows. The
  result can only change when a window completes, so it is memoised for an hour rather than
  recomputed per request; `clearLearnedCeilingsCache()` drops the memo.
- `server/src/api.ts` — `buildUsage` reads the trailing 8 days of sidecars (a day wider than
  the weekly window, since the file filter is day-granular while the windows are instant-granular)
  and hands `buildUsageLimits` the cached ceilings alongside them.
- `server/src/server.ts` — `/api/usage` plus `/api/usage/stream`, and `/api/summary/stream`
  so the rest of the Overview is live too. Both streams watch the log directory through the
  existing `serveSse` helper.
- `apps/admin/src/components/UsageMeter.tsx` and the `.usage-*` rules in `styles.css`.

## Notes

Because header capture is a proxy change, it only applies to requests captured after the
proxy restarts — existing sidecars have no `rateLimit`, so those windows fall back to the
estimate until fresh traffic arrives.

Restarting is not always enough. Anthropic returns `anthropic-ratelimit-*` headers on
API-key traffic; requests authenticated with a subscription OAuth token (`authorization:
Bearer`, with `oauth-…` in `anthropic-beta`) come back without them. On such an account the
header path never fires no matter how fresh the proxy is, which is precisely the case the
learned ceiling exists to cover.
