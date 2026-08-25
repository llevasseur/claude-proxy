# provider-seam-08 — Provider-scoped routes, and the three-origin fan-out

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-08-provider-scoped-routes-and-fanout`
**Status:** active

Depends on ticket 07.

## Criteria

1. **Every server route is provider-scoped and reads exactly one store.** A request for
   Anthropic never touches the OpenAI or Ox Alpha store.

2. **Three servers, not one.** Each stack keeps its own server and its own routes, and
   claude's dashboard fans out over **three origins**. This is
   [ADR 0062](../adrs/0062-three-servers-and-one-moved-port.md), and it is required twice
   over: [ADR 0046](../adrs/0046-narrowly-scoped-local-writes.md) gives each store a **sole
   controller**, so a second process reading ox's file is a second party against it; and
   the campaign's feature-flag rule means **no existing capability is removed**, so
   stranding `stacks/codex/server` and `stacks/ox-alpha/server` would discard ratified route
   behaviour governed by ADRs 0034, 0037, 0030 and 0026.

3. **Only claude's `admin` is the dashboard surface**, per
   [ADR 0042](../adrs/0042-claude-dashboard-is-the-design-baseline.md). Do not build a
   picker into codex's or ox's admin apps.

4. **The client fans out and merges above the store**, consuming ticket 07's per-provider
   envelope. A provider that fails contributes its typed reason, never a silent omission.

5. **Distinguish "server unreachable" from "store unreadable"** in what the client reports.
   They are different faults with different fixes — see criterion 3 of ticket 07.

6. **Do not sum tokens across providers**, here or anywhere
   ([ADR 0064](../adrs/0064-tokens-do-not-aggregate-across-providers.md)). Ticket 13 lands
   the series shape.

7. Tests: a provider-scoped route opens exactly one store and no other; a fan-out with one
   origin down still returns the other two plus a typed reason for the third; an unreachable
   origin and an unreadable store produce different reasons.

8. `my-command-tools verify` green.
