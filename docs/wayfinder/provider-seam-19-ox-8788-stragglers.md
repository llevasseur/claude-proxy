# provider-seam-19 — Sweep the four sites still naming ox's old 8788

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-19-ox-8788-stragglers`
**Status:** active

Ticket 09 moved ox's server default from `8788` to `8808` at
`stacks/ox-alpha/server/src/config.ts:86`, and updated `.zellij/README.md` and the root
`AGENTS.md`. Four sites outside that ticket's lane still name `8788`, and **two of them are
real breaks rather than staleness** — they point a default checkout back at the collision
[ADR 0062](../adrs/0062-three-servers-and-one-moved-port.md) removed, or at the wrong
provider's server entirely.

**This campaign must not close with these outstanding.** A moved default that only half the
repository knows about is not a moved default: an operator who copies the shipped
`.env.example`, or who runs ox's dashboard as shipped, lands in exactly the state 0062 was
written to end. Leaving them turns 0062's fix into a half-measure, and the half that is
missing is the half a fresh checkout actually meets.

This ticket touches ox's stack only. It changes no other port: claude's server stays `8788`,
codex's stays `4319`, the three proxies stay `8787`/`8026`/`8807`, and the three admin dev
servers stay on `5173`.

## Criteria

1. **`stacks/ox-alpha/server/.env.example:6` sets `OX_SERVER_PORT=8788`.** Anyone copying
   the shipped example to `.env` pins ox's server back onto claude's port and **recreates
   the exact collision ADR 0062 removed** — with the scoped variable that was supposed to
   be the escape hatch doing the pinning. Set it to `8808`, and rewrite the comment above
   it: it currently explains that `8788` is also claude's default and that the scoped name
   is how you run both at once, which describes the world before 09.

2. **`stacks/ox-alpha/apps/admin/vite.config.ts:7` and
   `stacks/ox-alpha/apps/admin/.env.example:2` aim ox's dashboard at
   `http://127.0.0.1:8788`** — the dev-server proxy target for `/api`, and the shipped
   `ADMIN_SERVER_URL` default behind it. **That address is now claude's server.** Ox's
   dashboard as shipped would proxy its API calls to claude's data and render it as ox's,
   silently and with no error anywhere. **This is the most serious of the four**: it is
   cross-provider contamination at the read path, which is precisely what
   [ADR 0046](../adrs/0046-narrowly-scoped-local-writes.md)'s n-stores/n-writers rule and
   this campaign's provider-scoped routes exist to prevent. Point both at `8808`.

3. **`stacks/ox-alpha/server/src/index.ts:14-15` reports `defaultPort: 8788`,** and its
   `port` field re-resolves `OX_SERVER_PORT ?? SERVER_PORT ?? 8788` independently of
   `config.ts`. `serverInfo()` is not on the listen path, so this one is cosmetic — but it
   is a second copy of a resolution that has already drifted once, and it is what any
   reader or diagnostic asking the server which port it defaults to would be told. Move
   both to `8808`, and update the assertion at
   `stacks/ox-alpha/server/test/index.test.ts:6` that pins the old value.

4. **Grep `stacks/ox-alpha/` for any remaining `8788` and account for every hit**, so a
   fifth site cannot hide behind a sweep of four. Some hits are correct and must stay:
   `stacks/ox-alpha/server/test/config.test.ts` names `8788` as **claude's** port on
   purpose, in a constant and in the dual-bind test, and the comment at
   `stacks/ox-alpha/server/src/config.ts:83` records what the default moved off. Leave a
   hit that refers to claude's server; change a hit that configures ox's.

5. **Change no port outside ox's stack**, and add no `superseded-by` key anywhere. ADR 0058
   holds that a partial supersession is not a supersession, and 0062 already records its
   amendment of ADR 0050 in prose alone — that stands, and this ticket does not revisit it.

6. Tests: ox's dashboard proxy target resolves to `8808` from the shipped example, and
   `serverInfo()` reports `8808` as its default.

7. `my-command-tools verify` green.
