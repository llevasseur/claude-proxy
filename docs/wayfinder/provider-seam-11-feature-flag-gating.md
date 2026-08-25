# provider-seam-11 — Capability gating on the two adapters

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-11-feature-flag-gating`
**Status:** active

Depends on ticket 01. **Read the first criterion before writing any code.**

## Criteria

1. **DO NOT DELETE ANYTHING. Every claude-proxy capability survives this campaign.**
   Removing a page, a metric, a route or a feature is **out of scope and a ticket that does
   it is rejected.** Gating is not deletion: a gated capability still exists, still has its
   code, and still renders for the sessions it applies to.

2. **What is Anthropic-wire-specific gates on the ProviderAdapter.** It answers false for a
   codex or ox session and does not render there.

3. **What is Claude-Code-specific gates on the HarnessAdapter.** Same.

4. **The two gates are independent**, per
   [ADR 0040](../adrs/0040-three-providers-and-three-harnesses.md): no capability may infer
   its provider gate from its harness gate or the reverse, even though today's three pairs
   are one-to-one. A capability that is genuinely both declares both.

5. **Audit every existing capability and classify it** — Anthropic-wire-specific,
   Claude-Code-specific, both, or neither. "Neither" is the common case and means it is
   ungated. Record the classification where a reader will find it; a silent gate is worse
   than no gate.

6. Tests: a gated capability renders for its own pair; the same capability answers false for
   the other two providers; a provider gate and a harness gate can disagree; and an ungated
   capability is unaffected by either.

7. `my-command-tools verify` green.
