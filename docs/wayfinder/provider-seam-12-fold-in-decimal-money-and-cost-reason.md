# provider-seam-12 — Fold in exact decimal money and the typed cost reason

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-12-fold-in-decimal-money-and-cost-reason`
**Status:** done · 2026-08-25

Independent of the spine by file scope — claude's core money and cost modules — so it may
run in the first wave.

## Criteria

1. **Fold in exactly two things from codex/ox, because both make the codebase stronger,
   cleaner or easier to read:**
   - **Exact decimal-string money arithmetic.** Both `stacks/codex/packages/core/src/pricing.ts`
     and `stacks/ox-alpha/packages/core/src/pricing.ts` already do this.
   - **The typed `CostUnavailableReason`.** codex has it — see
     `stacks/codex/packages/core/src/history.ts` — and **claude has no unavailable
     treatment at all**: neither `stacks/claude/core/src/cost-rate.ts` nor claude's admin
     components carry one. This is a real gap, not a stylistic difference.

2. **Fold in nothing else.** Anything that merely *differs* between the stacks does not
   qualify — **keep claude-proxy's way**. This criterion is a filter, and a change that
   cannot state which of stronger/cleaner/faster/easier-to-read it buys does not belong in
   this ticket.

3. **The typed reason satisfies [ADR 0020](../adrs/0020-unavailable-incomplete-cost.md)**,
   which requires the complete token metrics returned, the entire cost marked unavailable
   with a typed reason, cost nullable in sidecars, database rows, API summaries and the UI,
   and **never** a substituted zero.

4. **Coordinate with ticket 07**, whose store-absence reason mirrors this type. One pattern,
   two kinds of absence — do not let them drift into two unrelated enums.

5. **Keep `stacks/claude/core` deterministic and dependency-free.** Exact decimal arithmetic
   must not pull in a runtime dependency; both siblings do it without one.

6. Tests: money arithmetic is exact where floating point would drift; an unpriced model
   yields `null` plus a typed reason rather than `0`; every existing claude cost path still
   produces the same numbers it did before for priced models.

7. `my-command-tools verify` green.
