---
type: feature
title: Internet usage meter
description: The Overview carries a config-driven meter for internet wire-byte spend — a budget meter when a limit and reset day are set, a fortnight of daily totals when they are not, and a single note when net-server is not running.
tags: [dashboard, net, internet, budget, overview]
timestamp: 2026-08-27
scope: net
---

# Internet usage meter

## Summary

The Overview shows how much of the machine's internet allowance has gone. It is
**config-driven**: what it draws is decided by what is set on net-server, not by a
setting in the dashboard.

| Config state | What the Overview shows |
|---|---|
| `limitBytes` **and** `resetDay` both set | A budget meter — bytes spent this period against the limit, with the period's bounds named |
| Either unset | The last 14 days of daily wire-byte totals, so activity is still visible with no budget to measure it against |
| net-server not answering | One inline note, and nothing else |

Both states link to the `/internet` page for the full picture: the day chart at its own
window, the agent share, and the editor that sets the budget in the first place.

## Where the data comes from

net-server, a separate process on its own port — **not** the claude server the rest of
the Overview reads. The dashboard finds it at `VITE_NET_SERVER_URL`, defaulting to
`http://localhost:8531`, and reads three routes:

- **`GET /api/config`** decides the branch. It is the cheap route — three settings and
  no corpus scan — so which of the two renderings applies is settled without waiting on
  the summary, which recomputes the whole spend model at read time.
- **`GET /api/summary`** supplies the period bounds, and only on the budgeted branch.
  The period is derived from the reset day against *net-server's* clock, so it is read
  from the server rather than recomputed in the browser.
- **`GET /api/days?window=N`** supplies the figures — 14 days on the fallback branch,
  and on the budgeted branch a window sized to the period itself.

### The period total is summed, not read

`/api/summary.totals` is **corpus-wide** and carries no period-scoped figure, so it is
not what the meter shows. The period's spend is summed from the day buckets that fall
inside `summary.period`, which is why the budgeted branch asks for a second window of
days sized to the period rather than reusing the fallback's fortnight — a reset day far
enough behind puts the period's start outside 14 days, and the headline must not
quietly shrink to whichever window happened to be fetched.

This is the same approach the `/internet` page takes, for the same reason.

## Hole semantics

A day net-server holds no attributed samples for is a **hole, not a zero**. The
collector is an hourly timer inside the server process ([ADR
0072](../adrs/0072-collector-residency.md)), so an unattended machine records nothing
at all rather than recording quiet days. The meter treats that distinction as load
bearing in two places:

- The fallback chart passes `null` for an unknown day, and recharts draws no bar. A
  zero-height bar would be a claim that nothing crossed the wire.
- The budget meter reads **`—`** rather than `0` when no day in the period has samples,
  and says so underneath: *"No day in this period has attributed samples yet."*

The day-level rules behind `known` and `partial` — the delta rule, gap classification,
and which bytes are attributed to which local day — are [ADR
0069](../adrs/0069-delta-gap-and-day-semantics.md).

## The approximate labels

Two things on this feature are approximate by construction, and are labelled rather
than quietly presented as exact.

**Attribution is approximate.** Bytes are attributed by process name over hourly
samples ([ADR 0071](../adrs/0071-agent-pattern-matching.md)), so a process that starts
and finishes between two samples is never seen. The Overview meter shows no per-agent
breakdown at all — that lives on `/internet`, under its own `approximate` label.

**On this machine the agent share is empty**, and that is an ordinary answer rather
than a failure. This macOS build's `nettop` emits no row carrying both a process and an
interface, so every interface-bearing series is stored under a synthetic identity and
matches no agent pattern. Wire-byte **totals are unaffected and remain exact** — which
is precisely why the Overview meter, which shows only totals, is unaffected too.

**What counts as a wire byte** — `en*` interfaces, per-interface rows, loopback
dropped — is [ADR 0068](../adrs/0068-wire-bytes-and-per-interface-schema.md).

## The config surface

Two settings, both on net-server, both editable from the Budget card on `/internet` or
directly over `PUT /api/config`:

| Field | Meaning | Unset |
|---|---|---|
| `limitBytes` | The period's ceiling, in bytes. Positive integer. | No budget — the fallback chart |
| `resetDay` | Day of month the period restarts, 1–31. | No budget — the fallback chart |

**Both are required for a meter.** A limit with no reset day names no period to spend
it over, and a reset day with no limit names nothing to be near, so either one alone
falls back to the chart. Period bounds are clamped to short months, and an unset reset
day means the calendar month — [ADR
0070](../adrs/0070-period-boundaries.md).

Setting either to `null` clears it. The server validates every field before writing any
of them, so a rejected write stores nothing.

### The tone

The meter's colour tracks **pace, not fill** — the same meaning the
[usage limit meters](usage-limit-meters.md) beside it give those classes, since they
share the stylesheet. Spend is measured against how much of the period has elapsed: a
nearly-full bar on the last day of the period is fine, and a modest one on the second
day is not.

| Tone | When |
|---|---|
| `good` | Projects under 80% of the limit by the period's end |
| `signal` | Projects 80–100% |
| `warn` | Projects past the limit |
| `bad` | The limit is spent (≥ 99.5%) |

## Degrading when net-server is down

net-server is frequently not running — it is a device-local process, and the collector
only samples while it is up. So **the Overview must not depend on it**, and every read
of it is sealed inside one component with its own queries, each with retries off.

On any failure that component returns a single card and nothing else. An unreachable
server is named specifically, because it means something different from an error: there
are no figures for that interval rather than figures being withheld.

    net-server unreachable at http://localhost:8531 — internet spend not shown.

Nothing about that state reaches the rest of the page. The claude-server queries behind
the allowance meters, the stat tiles, and the two plots are untouched by it — the
Overview route gained one component and no change to any existing data path.

## Where it lives

- `stacks/claude/admin/src/components/InternetSpendCard.tsx` — the section: the three
  queries, the branch between meter and chart, the period sum, the pace tone, and the
  failure note. `getNetConfig` is declared here because `net-api.ts` exports the write
  half of `/api/config` but no reader for it.
- `stacks/claude/admin/src/components/InternetDaysChart.tsx` — the fallback chart, one
  bar per local day, `null` for a hole.
- `stacks/claude/admin/src/routes/overview.tsx` — renders `<InternetSpendCard />` after
  the usage meters. One import and one element.
- `stacks/claude/admin/src/net-api.ts` — the net-server client and its response types,
  shared with `/internet`.
- `stacks/net/packages/server/src/api.ts` — the four routes behind all of it.
