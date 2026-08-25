# provider-seam-17 — UI: the `interrupted` and `resumed` stream states

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-17-ui-interrupted-resumed`
**Status:** active

Depends on ticket 07. **Mandatory three-phase protocol — read it first.**

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

1. **`interrupted` and `resumed` are legible at a glance in a list.** A reader scanning
   rows should see which streams dropped without opening anything.

2. **An interrupted row must be honest that its token count is partial.** This is the
   substance of the ticket. [ADR 0046](../adrs/0046-narrowly-scoped-local-writes.md) keeps
   the tokens counted so far and flags the record `usage_complete: false`, and its own
   consequence is that "every usage aggregate must handle `usage_complete: false`, so a
   partial record is visible" rather than silently folded in. A partial count shown as a
   total is the same class of error as a zero shown for an unknown cost.

3. **The states are the hosting proxy's, with no cross-proxy coordination.** Per 0046, a
   stream that drops is recorded `interrupted` **by the hosting proxy alone**, and `resumed`
   only if that same proxy resumes it. Do not build a UI implying a cross-provider view of
   one stream.

4. **An interrupted stream that is never resumed stays `interrupted` permanently.** That is
   0046's stated consequence, not a bug — so the UI must not present it as pending, or as
   something that will resolve on its own.

5. **`resumed` is a distinct state, not the absence of `interrupted`.** A stream that was
   interrupted and then resumed carries real history, and collapsing it back to "fine"
   loses that.

6. **Do not sum tokens across providers in this or any list**
   ([ADR 0064](../adrs/0064-tokens-do-not-aggregate-across-providers.md)).

7. `my-command-tools verify` green, **including the GritQL rule**.
