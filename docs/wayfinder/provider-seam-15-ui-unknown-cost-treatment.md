# provider-seam-15 — UI: the `unknown` cost treatment

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-15-ui-unknown-cost-treatment`
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

1. **An unknown cost must never be mistakable for `$0.00` or for an empty cell.** That is
   the entire point. [ADR 0020](../adrs/0020-unavailable-incomplete-cost.md) exists because
   "a zero or partial estimate looks complete in an aggregate and understates spend", and
   its consequence is that the Overview "renders an unavailable state instead of `$0`".

2. **Show the typed reason**, not merely that the value is missing. The reason is what makes
   the state actionable — an unpriced model is a different problem from an incomplete
   record.

3. **The complete token metrics are still shown.** 0020 returns the tokens and marks only
   the *cost* unavailable. Do not blank the row.

4. **A home for the unpriced-rate meter** — some surface where a human can see what share of
   the corpus is currently unpriced, so this state is discoverable rather than only
   encountered. Coordinate with ticket 16, which surfaces the related fallback share; they
   may share one component.

5. **An aggregate containing an unknown is itself unavailable**, per
   [ADR 0044](../adrs/0044-every-model-gets-a-price-row.md)'s propagation rule — `null`
   propagates. The UI must not quietly sum around it.

6. **This is also the treatment a typed store-absence uses** where a page shows one
   (ticket 07). One visual language for "we do not know", not two.

7. `my-command-tools verify` green, **including the GritQL rule**.
