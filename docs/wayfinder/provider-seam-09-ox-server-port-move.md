# provider-seam-09 — Move ox's server default port off 8788

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-09-ox-server-port-move`
**Status:** done · 2026-08-25

Independent of the spine by file scope — this touches only ox's server config and its
tests, plus the ports documentation. It may run in the first wave.

## Criteria

1. **Change ox's server default port from `8788` to `8808`** at
   `stacks/ox-alpha/server/src/config.ts:86`, which currently defaults
   `OX_SERVER_PORT ?? SERVER_PORT` to `8788`. `8808` sits beside ox's own proxy default of
   `8807`.

2. **This is the one runtime default the campaign changes**, and it amends one clause of
   [ADR 0050](../adrs/0050-stack-scoped-environment-variables.md) — its "change none of
   these numbers". See [ADR 0062](../adrs/0062-three-servers-and-one-moved-port.md) for the
   reasoning: the collision was pre-existing awkwardness only while nothing required both
   servers up at once, and [ADR 0041](../adrs/0041-provider-picker-drives-the-navigation.md)'s
   picker requires exactly that. Applying 0050's own boundary test, it is now
   campaign-caused and in scope.

3. **Change no other port.** claude's server stays `8788`, codex's stays `4319`, the three
   proxies stay `8787`/`8026`/`8807`, and the three admin dev servers stay on `5173` —
   0062 leaves them deliberately, because the picker does not require them bound
   simultaneously.

4. **`OX_SERVER_PORT` already exists** from the fusion campaign's ticket 22, so the override
   path is in place. An override is **not sufficient** on its own: the requirement is that a
   **default checkout** works with the picker, and today's default does not.

5. **Add no `superseded-by` key to 0050, and none to 0062.**
   [ADR 0058](../adrs/0058-supersession-is-recorded-from-both-ends.md) is explicit that **a
   partial supersession is not a supersession**: its worked example is 0003 superseding one
   constraint in 0002, where marking 0002 "would tell a reader to disregard a record that
   still governs." The relation is stated **in prose and adds no key**. 0050 still governs
   the other eight ports and its whole scoped-variable scheme.

6. **Update `.zellij/README.md`**, which is the full record of the nine ports, and the ports
   table in the root `AGENTS.md`. Both currently say ox server `8788`.

7. Tests: the default resolves to `8808`; `OX_SERVER_PORT` still overrides it; the bare
   `SERVER_PORT` fallback still applies; and claude's and ox's servers can bind
   simultaneously with no configuration.

8. `my-command-tools verify` green.
