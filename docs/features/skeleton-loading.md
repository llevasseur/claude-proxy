---
type: feature
title: Skeleton loading
description: Every dashboard page reserves its content's own boxes while loading, so data arrives in place instead of pushing the page around.
tags: [dashboard, loading, accessibility, react]
timestamp: 2026-07-29
---

# Skeleton loading

## Summary

Every page in the admin dashboard shows a placeholder shaped like the content it is
fetching — the same stat grid, the same table, the same chart box — instead of a single
line of text. The placeholder occupies the boxes the real content will fill, so when the
data lands it simply appears where the outline was, with no reflow.

The same pass makes the interactions that *replace* already-loaded content — switching a
day window, re-sorting a table, flipping a document between Pretty and Raw — keep the
current content on screen while the next render is prepared, rather than emptying the
page and rebuilding it.

## Motivation

Every query-backed view funnelled through one component, `QueryState`, whose loading
state was `<p className="muted state">Loading…</p>`. Two problems followed from that:

- **The page collapsed and then jumped.** A 44px-tall line of text stood in for a screen
  of stat cards and a hundred-row table. When the data arrived the document grew by
  thousands of pixels in one frame. `useRestoredScroll` exists specifically to work
  around this: the router's own scroll restore runs while the route is still in its
  loading state, and *"a document that short cannot hold the offset, so the browser
  clamps it away."*
- **Switching a window threw the page away.** The 7/14/30-day switchers change the query
  key, so React Query reported `isLoading` for the new key and `QueryState` replaced the
  whole view with `Loading…` — even though a perfectly good previous window was already
  drawn and only needed redrawing.

## Behavior

**Placeholders are built from the real page's own classes.** `components/Skeleton.tsx`
composes shapes out of `.card`, `.card.stat`, `.table` and `.grid.stats`, putting the
shimmer *inside* those elements rather than replacing them. Each block is an
`inline-block`, so the element holding it keeps its own strut and line box: a skeleton
`.stat-value` is exactly as tall as a filled one, and neither side names a pixel height.
Heights therefore agree by construction rather than by a magic number that drifts.

**Counts come from what the page knows.** Where the eventual size is already determined,
the skeleton uses it: the trends charts and tables reserve one bar and one row per day in
the selected window, a suggestion bucket reserves ten session rows because a bucket is
always ten sessions, and a session's stat grid reserves seven tiles because the page — not
the data — fixes that number.

**A card is reserved with everything it carries, and lands once.** A stat tile on Overview
holds a sparkline under its value and the per-request chart holds a legend under its plot,
so the skeleton reserves those boxes too — otherwise the card is the right height until the
extra part appears and pushes the page down anyway. For the same reason the plot heights are
exported as `BAR_CHART_HEIGHT` and `SPARKLINE_HEIGHT` and read by both the chart and its
placeholder, rather than being duplicated in the stylesheet where the two could drift apart.
And where a view is assembled from two queries — Overview's tiles draw their mini charts from
the trends window, Skim's tiles from a second day query — the skeleton is gated on both, so
the row lands complete instead of arriving and then growing.

**Every page is covered.** All 27 `QueryState` call sites pass a skeleton, so the
`Loading…` text is now only a fallback for a caller that supplies none. The two pages that
are not a padded column are handled in their own shape: the Sessions rail loads as ghost
transcript rows into a grid column whose width is already fixed (the chat beside it is
usable from the first paint), and the live graph draws ghost node boxes onto its canvas at
the same `COMPACT` geometry and gaps the real snake uses.

**Content that is superseded stays put and dims.** `QueryState` takes a `busy` flag; the
window-switching pages pair `useTransition` with React Query's `placeholderData:
keepPreviousData`, so the drawn window survives the switch and is dimmed via `.is-stale`
while the next one arrives. The switcher itself stays live throughout and reports
`aria-busy`.

**`useTransition` is used for render cost, not for waiting on the network.** Without
Suspense, a transition's `isPending` does not track a fetch, so the two halves are
reported separately and combined by the caller: `isPending` from
`useTransitionState` covers the re-render, and the query's own `isFetching` covers the
request. The transitions are:

| Interaction | Page(s) | Why it is a transition |
|---|---|---|
| Day window 7/14/30 | Overview, Trends, Context size, Skim, Trend detail | Re-renders every chart and row in the window |
| Re-sorting a table | Context size, Projects, Project memories, Request breakdown | A month of requests is the longest list in the dashboard |
| Pretty ⇄ Raw | Session detail, Memory, Message, Tool schema | Rendered Markdown one way, a whole file in a `<pre>` the other |
| Hide resolved | Session suggestions | Re-renders every remaining suggestion card |

**Accessibility.** Shimmer blocks are decorative and carry `aria-hidden`; each loading
view announces itself once through a `role="status"` `.sr-only` element that is absolutely
positioned, so it can sit inside a grid or flex container without becoming an item in it.
The stylesheet's global `prefers-reduced-motion` rule already stops the shimmer animation,
so the skeleton also declares a flat fill for that case — otherwise the gradient would
freeze mid-sweep and leave the blocks unevenly lit.

## Notes

`useRestoredScroll` is kept. Reserving the content's height addresses the root cause it
was written for, but a skeleton's row counts are a good estimate of the page's height
rather than an exact match, so the explicit restore is still the belt to the skeleton's
braces.

The shared pieces this introduced also removed duplication that predated it: `Segmented`
replaces the hand-rolled `.segmented` button group that five pages repeated, and carries
the `DAY_WINDOWS` and `PRETTY_RAW` option sets those pages each declared for themselves.

## Acceptance criteria

- [x] Every `QueryState` call site passes a `skeleton`, so no page falls back to `Loading…`.
- [x] A skeleton occupies the same boxes as the content it stands in for, built from the
      page's own CSS classes rather than hardcoded heights.
- [x] Switching a day window keeps the drawn window on screen, dimmed, instead of
      replacing it with a skeleton.
- [x] Sort, view-toggle and filter interactions run as transitions and leave the current
      content in place while the next render is prepared.
- [x] Shimmer blocks are hidden from assistive tech; each loading view announces itself
      once, and the shimmer degrades to a flat fill under `prefers-reduced-motion`.
