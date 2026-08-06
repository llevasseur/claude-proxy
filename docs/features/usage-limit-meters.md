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
**weekly** window, and, when it applies, the **weekly Fable** window — each carrying a
sentence saying whether the current rate is comfortable, close to the ceiling, or on track to
run out early. The meters and the day's statistics both update while a session is running,
over Server-Sent Events, so the page reflects requests as the proxy captures them.

The bar's colour tracks the *pace*, not the fill level: a bar can be nearly full and still be
fine late in a window, while a modest bar early on can already be a problem. A faint extension
of the bar marks the utilization the current rate projects to by reset.

## Four sources, in order of preference

**Anthropic's own figures, polled.** The proxy asks
`GET https://api.anthropic.com/api/oauth/usage` — the endpoint Claude Code's own `/usage`
panel reads — once a minute, and writes the answer to `logs/usage-live.json`. A window
sourced from it is exact: Anthropic's percentage and Anthropic's reset instant, no ceiling
guessed at and no coverage caveat. It is the only exact source on a subscription account,
because such traffic comes back with no rate-limit headers at all.

The call needs the user's OAuth token, so the poll lives **in the proxy**, where that token
is already in memory to be forwarded. Only the resulting numbers reach disk — the credential
is never written, logged, or put in a sidecar. Requests authenticated with an `x-api-key` are
ignored: the endpoint is OAuth-only, and such accounts get real headers instead.

Polling is on a fixed 60-second timer rather than per request or per SSE tick — a busy
session would otherwise hammer it hundreds of times a minute. Writing the file also wakes the
existing log-directory watcher, so the Overview updates over SSE. A failed poll leaves the
previous file in place; readings older than five minutes stop being used as percentages but
keep serving as window anchors (below).

**Captured response headers, next.** The proxy records every
`anthropic-ratelimit-*` / `x-ratelimit-*` response header into the request's sidecar as
`rateLimit`, names lowercased and values verbatim. Those headers carry the real allowance and
the real reset instant, so a window sourced from them needs no configuration and is exact.
Headers are read from the *newest* captured request only — an older reading would understate
everything since.

Header names are matched by shape rather than against a fixed list: one segment names the
span (`5h`, `7d`/`week`), an optional one narrows it to a model family, and the last names the
field (`limit`, `remaining`, `used`, `utilization`, `reset`, `status`). A renamed or new window
therefore reaches the dashboard without a proxy change. Reset values are accepted as an ISO
instant, epoch seconds, epoch milliseconds, or seconds-from-now.

**A configured ceiling, next.** Anthropic does not publish subscription quotas as token
counts, so there is deliberately **no built-in default ceiling**. Set one to state the real
allowance:

| Variable | Window |
|----------|--------|
| `USAGE_LIMIT_5H` | rolling 5-hour |
| `USAGE_LIMIT_WEEK` | weekly |
| `USAGE_LIMIT_WEEK_FABLE` | weekly, Fable requests only |

Values accept `_`/`,` separators and `k`/`m` suffixes (`2.5m`, `900k`). A configured ceiling
always wins over a learned one: it states the allowance, where the learned figure only guesses
at its floor.

**A ceiling learned from history, otherwise.** A window with neither headers nor
configuration falls back to the busiest **completed** window on record — requiring an env var
per device meant a fresh checkout showed no meters at all. Only completed windows count: the
one in progress is still filling, and letting it set the bar would peg every meter at 100%.
Only windows the retained logs fully span count, since a window starting before the oldest
retained request is a fragment, not a window.

This is a **lower bound on the allowance, never the allowance**: the most that can be said is
"at least this much was possible". The error runs in one direction only — dividing by a ceiling
that is too low makes utilization read too *high*, so a learned meter overstates how close the
account is to its limit and cannot invent headroom that isn't there. The UI says so: the meter
is marked `inferred`, the status chip talks about records rather than limits (`Below record`,
`New record`), and the blurb points at the env var for anyone who knows the true ceiling.

A window kind with no traffic at all learns nothing rather than a ceiling of zero, which is
how the Fable meter stays absent on plans that never touch it.

### The unit

Both the estimate and its ceiling are in **weighted tokens**:

    input + output + cacheCreation + (cacheRead × 0.02)

`input` is used rather than `realInput` because `realInput` already sums
input + cacheRead + cacheCreation and would double-count.

**0.02 is a metering weight, not the cost ratio.** Cache reads *bill* at roughly a tenth of
fresh input ($0.50/MTok against $5/MTok on Opus). That tenth is still the right number for
money, and it lives in exactly one place — the `cacheRead`/`input` rows of `MODEL_PRICES` in
`pricing.ts`. Anthropic's rate-limit accounting discounts cache reads several times harder than
its billing does, and the meters were using the billing ratio for both.

The metering weight is measured, not assumed, and
`node scripts/derive-metering-weight.mjs` re-derives every figure below from the retained
sidecars — including the fixture block the tests check in. The four completed 5-hour windows
whose sidecars carry an `anthropic-ratelimit-unified-5h-utilization` header — every one on
record, from 2026-08-04 and 2026-08-05 — each pair a weighted count with Anthropic's own
utilization reading, so each implies an allowance. One allowance produced all four, so the right
weight is the one that makes them agree:

| Weight | Implied 5-hour ceilings | Worst departure from the mean |
|--------|-------------------------|-------------------------------|
| 0.1 (the billing ratio) | 54.7M / 47.1M / 44.2M / 50.6M | 11.3% |
| 0.02 (shipped) | 20.0M / 17.7M / 18.7M / 18.9M | 6.1% |
| 0.019 (best fit) | 19.5M / 17.4M / 18.4M / 18.5M | 6.0% |

**How firmly this pins the weight: the order of magnitude, and not the second digit.** Three
things limit it, and all three are worth stating plainly rather than leaving the table to imply
a precision it does not have.

- *The sample is near-collinear.* What identifies a cache-read weight is variation in how much
  of a window is cache reads — and across these four that share spans 1.2pp, 0.963 to 0.975.
  Identification therefore rests mostly on the 2026-08-05 12:50 window, the only one with
  materially more fresh input. Weights within a tenth of the best fit span **0.011–0.023**;
  within half of it, 0.001–0.045.
- *A residual survives at every weight.* Even at the optimum the four windows disagree by ~6%.
  Header quantization — utilization is reported to two decimal places — accounts for at most
  about 1pp of that, so the rest is misspecification the weight cannot absorb. Freeing a
  different term instead of the cache-read weight does worse, so this is at least the right knob:
  holding cache reads at the billing ratio and fitting a free output-token weight bottoms out at
  10.5%, and an output-tokens-only model at 9.9%, against 6.0% here.
- *A much larger sample agrees on the direction, not the digit.* Every request carries a reading,
  so within a window the readings can be regressed against the cumulative units at each instant —
  hundreds of points per window instead of four in total. That check bottoms out near **0.016**
  and roughly halves the residual against 0.1 (0.5–1.4% against 1.5–2.8%). It is the stronger
  evidence that 0.1 is wrong; it also puts the centre slightly below 0.02.

0.02 is a defensible round number inside that band, erring on the high side, which reads usage
high — the same direction the learned ceiling already errs in.

**Two caveats on the reading itself.** The utilization header is not strictly monotone within a
window: it steps *down* by 0.01–0.02 at a few dozen points out of a few thousand, so it is not
quite a plain running total — some lag, smoothing, or leak is in it. The effect is about a
percentage point and overturns nothing here, but the cumulative interpretation the fit rests on
is an approximation, not the header's definition. And whether Anthropic's unified unit is
token-based at all cannot be established from these logs; a weighted token count is the best
available proxy, not a model of the real accounting.

**Out of sample, the check that survives its own weakness.** 2026-07-28 reports no headers at
all, and the account demonstrably hit its 5-hour cap that day. Without a reset header there is
nothing to align a window to, so `--out-of-sample 2026-07-28` takes the busiest 5 hours anywhere
on the day and then the busiest disjoint from it. That free-floating maximum is an **upper bound**
on any fixed window, which cuts one way only — and that is what makes it useful. At 0.02 the
busiest 5 hours reach ~129% of the implied ceiling and the next ~75%: consistent with capping
out, though the 129% is itself a sign the unaligned maximum overstates. At 0.1 the busiest 5
hours reach only **79%** of the ceiling *that* weight implies. Since no aligned window can exceed
the unaligned maximum, 0.1 says the day could not have capped out — and it did. The weight is
wrong by more than alignment error can explain. (The exact percentages are alignment-sensitive
and should not be read as measurements; the inequality is the finding.)

**A configured ceiling is an absolute number in this unit**, so changing the weight invalidates
any `USAGE_LIMIT_*` value already set: the same traffic against an unchanged ceiling reads about
five times lower. `server/.env.example` was rescaled with the weight. Its figures are this
device's, rounded *down* from what the headers imply — ~19M per 5-hour window and ~154M per week
(the latter from the 7-day headers over a fully-retained window) — because a lower ceiling reads
usage high, which is the direction that surfaces a problem rather than hiding one. Anyone who set
those variables by hand at the old weight must divide their values by about five.

**Why the error was invisible.** Usage and the learned ceiling are counted in the same units, so
a wrong weight divides out of the ratio and both meters look fine — for exactly as long as the
cache-hit ratio holds steady. It surfaces only when the token mix moves, and then it moves both
meters at once. That is what makes the weight worth pinning to observations and testing against
them rather than inferring it from the price sheet.

For scale, an active coding day on this device runs ~16M units per 5-hour window, against a
5-hour ceiling of about 19M.

## Fixed windows, not trailing ones

Anthropic's weekly allowance is a **fixed** window that resets at a published instant — "resets
Aug 8 at 8am" — not a trailing seven days. Estimating over a trailing week counts usage against
an allowance that already reset: on this device a **5.6× overcount**, 83.0M weighted units where
14.9M actually belonged to the window in progress. (Those two absolute figures were measured at
the old 0.1 weight; the ratio between them is the point and is what carries over.)

So the estimate anchors to the real reset instant whenever one is known. The anchor comes from
the live poll and **outlives it**: allowances reset on a fixed cadence, so an instant that has
already passed is rolled forward by whole windows and still marks where the current one opened.
A week-old reading is enough to keep the estimate anchored. With no anchor ever seen, the window
falls back to trailing — wrong in a known direction rather than unknowably.

Coverage for an anchored window is measured against the part that has *elapsed*, not the nominal
span. A weekly window seven hours old with all seven hours retained is completely covered;
judging it against 168 hours would read 4% and stamp `partial` on a complete count.

## Coverage — how much of a window is actually on disk

`logs/` retains roughly the current day; `pnpm --filter server maintain` relocates past days
into `logs/archive/<date>/`. Every `.audit.json` is kept there forever and no day directory is
ever removed — only the `.md` and `.request.txt` bodies are evicted, past `RETENTION_DAYS`
(30) — so eviction can never take coverage down with it. The live directory alone therefore
cannot see a whole weekly span — measured at 3% of the window on this device, a weekly figure
drawn from about five hours of logs.

So both halves of the estimate read the archive. `buildUsage` unions the live directory with
the archived days the windows reach into, which is the count itself; `learnCeilings` reads
four weeks of it for the ceiling that count is divided by. Both are cached rather than run per
request — `/api/usage/stream` rebuilds on a 600ms debounce, and re-reading thousands of
sidecar files per tick is not affordable. Archived days are memoised individually for the
process lifetime, and both passes read a day through that one memo, so a day inside both spans
is parsed once. An *absent* day is deliberately not cached: the archive job may not have run
yet, and a sticky miss would pin the gap in place until restart. Live and archived reads are
deduped by source filename, so an archiver that copies rather than moves cannot double every
request in the seam.

Each estimated window reports `coverage`, the fraction of the window actually backed by
retained logs. Below 0.95 the blurb says the real figure is higher, and the foot carries an
amber `partial` chip — but only where the reset instant is unknown, since a known reset is the
more useful thing to put there; an anchored window makes the same admission in its blurb
alone. The header path is always `coverage: 1`, since Anthropic counts the window itself.

**Coverage counts the days held, not the span back to the oldest surviving request.** Measuring
from the oldest record reads a hole in the middle of a window as full coverage, taking the
`partial` marking with it. Days are the unit because rotation is day-granular: a quiet stretch
inside a retained day is genuinely quiet, while a missing day directory is a hole. Day ends
resolve as the next day's start, so the two DST changeover days keep their real 23 and 25
hours.

An archived day counts as retained when its own directory is on disk; today is retained by
definition, as is any day a still-live sidecar's timestamp names. Because a reporting day can
straddle `<date>` and `<date + 1>` — archive folders take the UTC date each log filename opens
with — requiring the day's own folder can understate coverage at that seam. That is the safe
direction: it marks the window `partial` rather than presenting an incomplete count as a total.

## The pace read

The sustainable rate is spending the whole allowance over the whole window, so the projection
is `utilization / elapsed`, and `elapsed` follows from the reset instant — a window resetting
in 1h of 5h is 80% gone. Statuses:

| Status | When | Tone |
|--------|------|------|
| `safe` | projects under 80% by reset | `--good` |
| `on-pace` | projects 80–100% | `--signal` |
| `aggressive` | projects over 100% — runs out before reset | `--amber` |
| `exhausted` | allowance spent (utilization ≥ 99.5%) | `--coral` |

A trailing estimate has no reset to run up against — the window *is* the last N hours — so
`elapsed` is 1 and the projection is where it already sits. It also gets its own vocabulary:
passing a configured ceiling means the estimate exceeded a budget the operator chose, **not**
that Anthropic is refusing anything, and only the header path says requests will be refused.

A learned ceiling gets a third vocabulary, weaker still, since it can support no claim about
the actual limit: `safe` reads as "below the busiest window on record" rather than "within
limits", and passing the bar is called new territory, not exhaustion — a new record, not a
refusal.

Two states are deliberately *not* shown as reassuring zeroes: a window with no headers, no
configured ceiling, and too little history to complete a window is omitted, and when no
requests were captured at all no estimated window is emitted, because a 0% meter would read as
"well within limits" when the truth is "nothing was observed".

## Where it lives

- `packages/core/src/usage-limits.ts` — header parsing, the weighted unit, coverage, the pace
  assessment, and `learnCeilings`. `CACHE_READ_METERING_WEIGHT` is the only cache-read weight
  here, and its doc comment says at length that it is *not* the billing ratio — that one stays
  where money is actually computed, in `pricing.ts`'s `MODEL_PRICES`, so there is no second
  constant to drift out of step with the price sheet. Pure;
  `buildUsageLimits(sidecars, { limits, learned, retainedDays, live, anchors, now })` takes an
  injected `now`, so every threshold is testable. `retainedDays` switches coverage from the
  oldest-record span to the days actually held; omitted, it falls back to that span.
  `USAGE_LIMIT_ENV_SUFFIX` is the one source of truth for the env-var names, shared with the
  server so a blurb cannot name a variable the server doesn't read.
  `parseLiveUsage` maps the endpoint's `kind` values onto the meters: `session` and `weekly_all`
  are the spellings it returns today, `five_hour`, `seven_day` and `seven_day_opus` are accepted
  alongside them, and `weekly_scoped` is narrowed by `scope.model.display_name`. An unrecognised
  kind is skipped, so a window Anthropic adds falls through to the estimate rather than landing
  on the wrong meter.
- `packages/core/src/time.ts` — `dayStartMs` resolves a day label to the instant local midnight
  opens it, applying the zone offset twice so the changeover days land right.
- `proxy/usage-live.ts` — the 60-second poll and the token it holds in memory. `noteAuth` takes
  the bearer off each forwarded request; `pollOnce` writes `usage-live.json` atomically and
  leaves the old file alone on failure.
- `server/src/usage-live.ts` — reads that file, expires the percentages after five minutes, and
  rolls stale reset instants forward into the current window.
- `server/src/usage-history.ts` — `loadArchivedUsage` (the archived sidecars plus which days are
  retained) and `loadLearnedCeilings`, which reads 28 days of live plus archived sidecars and
  learns the fallback ceilings from them. Four weeks leaves room for three completed weekly
  windows. That result can only change when a window completes, so it is memoised for an hour
  rather than recomputed per request; `clearLearnedCeilingsCache()` drops the memo. Both passes share one per-day archive memo,
  cleared by `clearArchivedUsageCache()`.
- `proxy/proxy.ts` — `extractRateLimit` copies only `anthropic-ratelimit-*` / `x-ratelimit-*`
  names off the upstream response, so no auth can ride along. The field is omitted entirely
  when upstream sent none, and a skim-cache-served request records none because no upstream
  call happened.
- `scripts/derive-metering-weight.mjs` — re-derives the metering weight from retained sidecars
  and prints the `OBSERVED_5H_WINDOWS` fixture block verbatim, so that fixture is regenerable
  rather than a set of numbers someone once pasted in. `--out-of-sample <date>` reconstructs a
  header-less day's busiest 5-hour windows, `--monotonicity` reports where the utilization header
  steps backwards, and `--json` emits the lot for further analysis.
- `server/src/usage-config.ts` — resolves the configured ceilings from the environment.
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
header path never fires however fresh the proxy is — measured here, 0 of 12,929 captured
sidecars carried a `rateLimit` field. That is the gap the polled endpoint closes, and why the
learned ceiling had to exist before it.

The poll needs a token, and the proxy only has one once a request has passed through it: a
freshly-started proxy shows the estimate until the first request, then the real figures a
minute later.
