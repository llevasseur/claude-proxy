# monorepo-fusion-22 — Implement the three ADR 0050 scoped names that never shipped

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-22-finish-adr-0050-scoped-names`
**Status:** done · 2026-08-24

## Why this ticket exists

ADR 0050 specifies **six** stack-scoped environment variable names, each with the package's
current bare name kept as a package-scoped fallback. Ticket 14 measured what actually
exists, and **only three of the six do**:

| variable | state | landed by |
|---|---|---|
| `OX_PROXY_PORT` | implemented | ticket 06 |
| `OX_SERVER_PORT` | implemented | ticket 06 |
| `CODEX_SERVER_PORT` | implemented | ticket 05 |
| `CLAUDE_PROXY_PORT` | **missing** | — |
| `CLAUDE_SERVER_PORT` | **missing** | — |
| `CODEX_PROXY_PORT` | **missing** | — |

The gap has a cause worth naming: tickets 05 and 06 were the absorption tickets, so each
scoped *its own* stack as it came in. **claude's config had no equivalent ticket** — it was
relocated by 02 and renamed by 03, neither of which owned its runtime configuration — and
codex's proxy was simply missed alongside its server.

**claude's proxy and claude's server both read bare `PORT` today.** That is a pre-existing
collision rather than a fusion-caused one, so under ADR 0050's own boundary it is not
urgent — but it is precisely what the scoped names exist to make overridable, and leaving
the decision half-implemented is worse than either finishing it or reversing it, because a
reader of ADR 0050 will assume all six exist.

## Criteria

1. **Implement the three missing names**, each following the pattern tickets 05 and 06
   already established:
   - `CLAUDE_PROXY_PORT` in `stacks/claude/proxy/`
   - `CLAUDE_SERVER_PORT` in `stacks/claude/server/`
   - `CODEX_PROXY_PORT` in `stacks/codex/proxy/`
2. **Each package keeps its current bare name as a fallback, scoped to that package alone.**
   A stack launched exactly as it is launched today must resolve exactly as it does today —
   that is the whole reason ADR 0050 is not a behaviour change.
3. **Three config-test cases per package**, matching what tickets 05 and 06 added: the scoped
   name wins, the legacy bare name still resolves, and the default is the unchanged number
   (claude proxy 8787, claude server 8788, codex proxy 8026).
4. **Change no default port.** Not one number.
5. **Read tickets 05's and 06's diffs first** and match their shape rather than inventing a
   third idiom for the same thing. Three implementations of one pattern that differ
   cosmetically is how a convention stops being one.

## Constraints

- Own `stacks/claude/proxy/`, `stacks/claude/server/` and `stacks/codex/proxy/` — their
  config modules and tests only.
- **Zero behaviour change.** A rename with a preserved fallback is not one; anything that
  alters what a package *does* is out of scope.
- Every file touched must pass at `error` under Biome and anti-slop, per the ratchet.

## Done when

All six of ADR 0050's names exist, each package's three config-test cases pass, no default
port changed, and `gh pr checks` is green.
