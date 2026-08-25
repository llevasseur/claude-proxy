# provider-seam-16 — UI: the `fallback:<proxy>` stamp

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-16-ui-fallback-stamp`
**Status:** active

Depends on ticket 06. **Mandatory three-phase protocol — read it first.**

## The design protocol (mandatory, all four UI tickets)

1. **Design.** Dispatch the **Claude Fable design subagent**, **only for the design**. Tell
   it to load `/frontend-design`, `/emil-design-eng` and `/animation-vocabulary`. It returns
   an implementable spec against `stacks/claude/admin/src/styles/tokens.css` — the
   post-fusion path, **not** `apps/admin/src/styles/tokens.css`.
2. **Implement.** The normal agent implements it.
3. **Verify.** The **same** Fable subagent verifies in Chrome with the browser tool and
   returns a pass or a specific list of misses. **The implementer does not verify its own
   UI work.**

**Read the dev server's actual bound port from its startup output** — a stale instance on
the default port serves old assets and fakes a pass. **If the browser backend is
unavailable, record the missing evidence in the PR** rather than passing quietly.

**No bare px in `padding`, `margin`, `gap`, `font-size` or `border-radius`** — the GritQL
rule at `stacks/claude/admin/lint/no-bare-size.grit` refuses it repo-wide. Use
`var(--space-N)`, `var(--text-N)`, `var(--radius-N)`, or add a **named** token. Steps:
`--space-1..12` plus `--space-page{,-lg,-xl}`, `--text-1..10`, `--radius-1..7` plus
`--radius-pill`.

## Criteria

1. **A `fallback:<proxy>` price must be distinguishable from a matched price at a glance —
   without reading as an error.** This is the design problem: it is a **normal state**, not
   a fault and not a warning. A red badge or an alert icon is wrong.

2. **It is also not invisible.** [ADR 0044](../adrs/0044-every-model-gets-a-price-row.md)
   states the purpose plainly: "the dashboard can show what share of a total rests on
   fallback rates rather than published ones." A stamp nobody can see does not serve that.

3. **Name the proxy.** `fallback:<proxy>` carries which proxy's fallback row priced it, and
   that distinction matters — a fallback under one provider says nothing about another.

4. **Show the share of a total that rests on fallback rates**, somewhere a human will find
   it. Coordinate with ticket 15's unpriced-rate meter; these two are the same kind of
   surface and may share a component.

5. **The stamp is resolved at read time, not stored** — see
   [ADR 0065](../adrs/0065-cost-is-resolved-at-read-time.md). So it changes the moment an
   operator edits a rate on ticket 14's page, with no write and no refresh of stored data.
   The UI must not cache it in a way that outlives a rate edit.

6. **Three states, visually distinct**: matched published price, `fallback:<proxy>` price,
   and unknown (ticket 15). The middle one must not read as a degraded version of the third.

7. `my-command-tools verify` green, **including the GritQL rule**.
