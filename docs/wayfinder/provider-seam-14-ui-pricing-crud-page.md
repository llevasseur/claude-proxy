# provider-seam-14 — UI: the pricing CRUD page

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-14-ui-pricing-crud-page`
**Status:** active

Depends on ticket 06. **This ticket has a mandatory three-phase protocol — read it first.**

## The design protocol (mandatory, all four UI tickets)

1. **Design.** Dispatch the **Claude Fable design subagent**, and use it **only for the
   design**. Tell it to load `/frontend-design`, `/emil-design-eng` and
   `/animation-vocabulary`. It returns an **implementable spec** written against
   `stacks/claude/admin/src/styles/tokens.css` — note the post-fusion path; it is **not**
   `apps/admin/src/styles/tokens.css`.
2. **Implement.** The normal agent implements that spec.
3. **Verify.** The **same** Fable subagent verifies it in Chrome with the browser tool,
   comparing what renders against what it specified, and returns a **pass** or a specific
   list of misses. **The implementer does not verify its own UI work.**

**Read the dev server's actual bound port from its startup output** rather than assuming the
default — a stale instance on the default port serves old assets and fakes a pass. **If the
browser backend is unavailable, record the missing evidence in the PR** rather than passing
quietly.

**Never let a bare px into `padding`, `margin`, `gap`, `font-size` or `border-radius`.** The
GritQL rule at `stacks/claude/admin/lint/no-bare-size.grit` refuses it, and it applies
repo-wide — it cannot be scoped to one stack on the pinned Biome 2.5.6. Pick a scale step
(`var(--space-N)`, `var(--text-N)`, `var(--radius-N)`) or add a **named** token beside
`--space-page`. Available steps: `--space-1..12` plus `--space-page{,-lg,-xl}`,
`--text-1..10`, `--radius-1..7` plus `--radius-pill`.

## Criteria

1. **A real validated form** over the four rates per model — input, output, cache-read,
   cache-write — **with a visible save state. NOT a JSON textarea.** This is where a human
   types in the rates for a model the catalogue has never seen, so the form is the product,
   not a debug affordance.

2. **Validation is real**: a non-numeric or negative rate is refused at the field with a
   message naming what is wrong, not on submit with a generic failure.

3. **The save state is visible** — idle, saving, saved, failed — and distinguishable at a
   glance. A save that failed must never look like one that succeeded.

4. **Editing a rate reprices the corpus**, per
   [ADR 0044](../adrs/0044-every-model-gets-a-price-row.md), and the page should be honest
   that historical numbers move. 0044's own stated consequence is that "an operator
   correcting a typo will see last month's totals move" — surface that rather than hiding
   it.

5. **No effective dating.** One current rate per model; no `valid_from`, no rate history UI.
   Do not build a version timeline.

6. The page is a new route module and gets a registry entry per ticket 10's rules — `nav`
   as `as const satisfies NavEntry`, `ROUTES`/`STATIONS` `as const`.

7. `my-command-tools verify` green, **including the GritQL rule**.
