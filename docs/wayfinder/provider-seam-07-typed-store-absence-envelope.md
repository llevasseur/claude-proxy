# provider-seam-07 — The typed store-absence envelope

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-07-typed-store-absence-envelope`
**Status:** active

Depends on tickets 03, 04 and 05 — it needs all three stores to fan out over.

## Criteria

1. **A fan-out read never returns a bare gap.** Each provider contributes either data or a
   **typed reason**, in a per-provider envelope. This is
   [ADR 0060](../adrs/0060-a-stores-absence-is-typed.md).

2. **Three states stay distinct**, because two are absences and one is a measurement:
   - **Store never created** — that proxy has never run. Typed reason, `null`, not zero.
     "No instrument", not "no traffic". A steady state a human may ignore.
   - **Store present but unreadable** — locked, corrupt, or mid-migration. A **distinct**
     typed reason, because this is a fault a human should act on. This is the state
     [ADR 0046](../adrs/0046-narrowly-scoped-local-writes.md) means by "legible as *this
     provider is unavailable*".
   - **Store present, healthy, zero rows in range** — a **real measurement of zero**, which
     renders as a genuine zero series. Do **not** collapse it into either absence.

3. **A fault outside the store is not state (2).** A server that failed to bind is an
   infrastructure fault, not an unreadable store, and reporting it as (2) is the
   misattribution [ADR 0062](../adrs/0062-three-servers-and-one-moved-port.md) exists to
   prevent. Give it its own reason.

4. **The typed reason mirrors `CostUnavailableReason`** — the same pattern applied to a
   second kind of absence. Ticket 12 folds that type into claude's core; coordinate rather
   than duplicating it.

5. **No cross-provider join at the storage layer** — ADR 0046 line 72. Query each store,
   combine above it.

6. **One source, three readers.** The same envelope feeds the page's per-provider
   unavailable state, the aggregate's propagation decision, and the picker's degraded
   indicator ([ADR 0041](../adrs/0041-provider-picker-drives-the-navigation.md)).

7. Tests: each of the three states produces its own distinct reason; a genuinely-zero
   provider is **not** reported as absent; an unreadable store does not take down the other
   two providers' data; and an aggregate over a partially-available fan-out propagates
   per ADR 0044's rule rather than silently dropping a provider.

8. `my-command-tools verify` green.
