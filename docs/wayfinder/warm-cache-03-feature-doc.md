# warm-cache-03 — The feature doc

**Wayfinder:** `warm-cache`
**Branch:** `task/warm-cache-03-feature-doc`
**Status:** done · 2026-09-15

Touches only `docs/`, so it shares wave 1 with tickets 01 and 04 without colliding.

## Criteria

1. **Add `docs/features/keep-a-chat-warm.md`**, an OKF concept with `type: feature` and
   `scope: claude`, matching the frontmatter of its siblings in `docs/features/`.

2. **Write it the way `retention-lifecycle.md` is written** — a Summary, a Motivation that
   carries the measurement rather than an assertion, and a Behavior section. That doc is
   the model because it leads with the number that decided the design, which is exactly
   what this feature needs.

3. **Content it must carry**, all of it already established and none of it to be
   re-derived:

   - **What it does.** Re-sends a registered session's previous request with
     `max_tokens: 0` on a padded timer, so the prompt cache entry's timer is refreshed by
     a cache read instead of expiring. Capped at 8 hours.
   - **The economics, in the right currency.** `usageUnits`, not dollars: one ping on a
     200k prefix is 4,000 units against 200,000 for the cold write it avoids, roughly 5.5x
     leverage. Cite `CACHE_READ_METERING_WEIGHT` in
     `stacks/claude/core/src/usage-limits.ts` and
     [ADR 0073](../adrs/0073-keep-alive-is-justified-in-usage-units.md).
   - **The honest counter-measurement, stated plainly and not buried.** 9.6% of sessions
     resumed after a cache-expiring gap against a 15.5% break-even, so registering on every
     session at 8 hours is net negative; median session lifetime was 9.9 minutes and no
     session in the corpus lived past 3.6 hours. Link
     [ADR 0078](../adrs/0078-resume-rate-is-below-break-even.md). **Do not soften this.** A
     feature doc that omits it is selling something the evidence does not support.
   - **The sample's limits**, every time a number appears: one account, one working day,
     capture ending 20:30, and no overnight away-stretch in the sample at all.
   - **How to use it.** `/warm`, and the `/__warm` endpoint's three methods.
   - **What it deliberately does not do.** No admin card
     ([ADR 0079](../adrs/0079-warm-json-ships-without-a-dashboard-card.md)); no sidecar
     schema change ([ADR 0077](../adrs/0077-a-ping-never-enters-handle.md)); nothing
     persisted but status.

4. **Cross-link all seven ADRs** — 0073 through 0079 — by relative path, and make sure each
   link resolves. `node scripts/check-docs.mjs` fails on a link to an untracked file, so
   commit the doc and the links together.

5. **Regenerate the index.** `okq --bundle docs index` updates `docs/features/index.md`.
   The docs gate asserts section indexes by file
   ([ADR 0056](../adrs/0056-the-docs-gate-asserts-indexes-by-file.md)), so a new feature
   that is not in the index fails the gate.

6. **Add a `CHANGELOG.md` entry** under `## [Unreleased]`, one bullet, prepended. The file
   is `merge=union` per `.gitattributes`, so add a line rather than rewriting an existing
   one.

## Out of scope

Any source change. Any ADR edit — the seven are written and are append-only; if this
ticket finds one wrong, say so in the pull request rather than editing it.

## Done when

`node scripts/check-docs.mjs` passes, `okq --bundle docs validate` reports no new errors,
and `my-command-tools verify` passes.
