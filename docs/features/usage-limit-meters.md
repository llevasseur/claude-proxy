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

## Two sources, in order of preference

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

**An estimate from logged tokens, otherwise.** Anthropic does not publish subscription quotas
as token counts, so there is deliberately **no built-in default ceiling**: a window with
neither captured headers nor a configured limit is omitted rather than drawn against a number
this repo invented. Configure a ceiling to opt a window in:

| Variable | Window |
|----------|--------|
| `USAGE_LIMIT_5H` | rolling 5-hour |
| `USAGE_LIMIT_WEEK` | weekly |
| `USAGE_LIMIT_WEEK_FABLE` | weekly, Fable requests only |

Values accept `_`/`,` separators and `k`/`m` suffixes (`2.5m`, `900k`). Setting
`USAGE_LIMIT_WEEK_FABLE` is what makes the Fable meter appear on the estimated path — which is
how "optional based on plan" is expressed, since only some plans meter that window separately.

### The unit

Both the estimate and its ceiling are in **weighted tokens**:

    input + output + cacheCreation + (cacheRead × 0.1)

Cache reads bill at roughly a tenth of fresh input, so they weigh a tenth here; counting them
at par would let a cache-heavy hour dwarf every real request. `input` is used rather than
`realInput` because `realInput` already sums input + cacheRead + cacheCreation and would
double-count. As a sense of scale, an active coding day on this device runs ~14M units per
5-hour window.

## Coverage — why an estimated weekly window reads low

`logs/` retains roughly the current day; older days are relocated out by an external job, and
what the archive keeps is per-day *digests*, not raw per-request sidecars. An estimated weekly
window therefore routinely cannot see its whole span, and would silently under-report.

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

Two states are deliberately *not* shown as reassuring zeroes: a window with no configured
ceiling and no headers is omitted, and when no requests were captured at all no estimated
window is emitted, because a 0% meter would read as "well within limits" when the truth is
"nothing was observed".

## Where it lives

- `packages/core/src/usage-limits.ts` — header parsing, the weighted unit, coverage, and the
  pace assessment. Pure; `buildUsageLimits(sidecars, { limits, now })` takes an injected
  `now`, so every threshold is testable.
- `proxy/proxy.mjs` — `extractRateLimit` copies only `anthropic-ratelimit-*` / `x-ratelimit-*`
  names off the upstream response, so no auth can ride along. The field is omitted entirely
  when upstream sent none, and a skim-cache-served request records none because no upstream
  call happened.
- `server/src/usage-config.ts` — resolves the ceilings from the environment.
- `server/src/api.ts` — `buildUsage` reads the trailing 8 days of sidecars (a day wider than
  the weekly window, since the file filter is day-granular while the windows are instant-granular).
- `server/src/server.ts` — `/api/usage` plus `/api/usage/stream`, and `/api/summary/stream`
  so the rest of the Overview is live too. Both streams watch the log directory through the
  existing `serveSse` helper.
- `apps/admin/src/components/UsageMeter.tsx` and the `.usage-*` rules in `styles.css`.

## Notes

Because header capture is a proxy change, it only applies to requests captured after the
proxy restarts — existing sidecars have no `rateLimit`, so those windows fall back to the
estimate until fresh traffic arrives.
