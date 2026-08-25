# Dev session layouts, and the nine ports

Three zellij layouts, one per stack, each opening that stack's proxy, server and admin
in a `dev` tab plus a spare shell. Launch one with `pnpm zellij` from the stack whose
session you want — the root script starts claude's, `stacks/codex` and
`stacks/ox-alpha` start their own.

All three layouts live here rather than under their stacks, and that move repaired
something rather than tidying it. Each stack's `scripts/zellij.sh` resolves
`git rev-parse --show-toplevel` and `cd`s there, which after fusion is the *monorepo*
root, and then asks for `.zellij/<stack>.kdl` — a path that did not exist until these
files arrived. Both sibling launchers were broken on arrival and are not any more.

| Layout | Launched by | Panes run from |
|---|---|---|
| [claude-proxy.kdl](claude-proxy.kdl) | `pnpm zellij` | the monorepo root |
| [codex-proxy.kdl](codex-proxy.kdl) | `stacks/codex` → `pnpm zellij` | `cwd "stacks/codex"` |
| [ox-alpha-proxy.kdl](ox-alpha-proxy.kdl) | `stacks/ox-alpha` → `pnpm zellij` | `cwd "stacks/ox-alpha"` |

The two sibling layouts pin `cwd` per pane because a bare `pnpm proxy` at the monorepo
root resolves to the *root* script, which is claude's. `cwd` also keeps each script's
own relative paths working — ox's proxy script is
`node --env-file-if-exists=proxy/.env …`, resolved against the working directory, so
from anywhere else it finds no `.env` and silently falls back to a default.

**A stack that grows more processes grows more panes in its own layout, not a second
layout.** codex recorded this for the Plane rung of its ladder and it is the rule for all
three: one session per stack is what makes `pnpm zellij` mean the same thing everywhere,
and a second layout for the same stack splits that stack's processes across two sessions
nobody starts together.

## The nine defaults

These are the ports the code actually binds today, read from source rather than from a
specification. **Nothing here is a target to converge on: change no number.** ADR 0050
struck "allocate nine distinct ports" — that was a remedy for a collision fusion did not
create, and renumbering would itself be the runtime change this campaign forbids.

| stack | proxy | server | admin |
|---|---|---|---|
| claude | 8787 | 8788 | 5173 |
| codex | 8026 | 4319 | 5173 |
| ox-alpha | 8807 | 8788 | 5173 |

Which name each one reads, and where the default is written:

| | variable read | falls back to | default in |
|---|---|---|---|
| claude proxy | `CLAUDE_PROXY_PORT` | `PORT` | `stacks/claude/proxy/config.ts` |
| claude server | `CLAUDE_SERVER_PORT` | `PORT` | `stacks/claude/server/src/config.ts` |
| codex proxy | `CODEX_PROXY_PORT` | `PROXY_PORT` | `stacks/codex/proxy/src/config.ts` |
| codex server | `CODEX_SERVER_PORT` | `PORT` | `stacks/codex/server/src/config.ts` |
| ox proxy | `OX_PROXY_PORT` | `PROXY_PORT` | `stacks/ox-alpha/proxy/src/config.ts` |
| ox server | `OX_SERVER_PORT` | `SERVER_PORT` | `stacks/ox-alpha/server/src/config.ts` |

The three admin ports are Vite's, set in each stack's `vite.config.ts`: claude pins
`5173` with `strictPort`, so it refuses to drift and fails loudly instead; codex sets
`5173`; ox sets nothing and takes Vite's own default, which is `5173` too.

**All six of ADR 0050's scoped names exist.** `CODEX_SERVER_PORT` (ticket 05),
`OX_PROXY_PORT` and `OX_SERVER_PORT` (ticket 06) arrived with the absorption tickets, and
ticket 22 added `CLAUDE_PROXY_PORT`, `CLAUDE_SERVER_PORT` and `CODEX_PROXY_PORT`. Each
keeps its bare name as a fallback scoped to its own package, so a stack launched exactly
as it is launched today resolves exactly as it did — **no default in the table above
moved**, and ADR 0050 now describes this repository rather than a state it had not
reached.

**claude's proxy and server validate nothing, and that is the one asymmetry worth
knowing.** Neither package had a config module at all before ticket 22: `Number()` of a
bad value yields `NaN` and `listen` decides. The siblings all range-check and throw, and
adopting that check would have turned a launch that works today into one that throws —
the runtime change ADR 0050 exists to avoid. So claude's two took the siblings'
*resolution order* and left the parsing alone, which is why claude's proxy has three
port cases in `stacks/claude/proxy/config.test.ts` where codex's proxy has four: the
fourth asserts a rejection claude deliberately does not perform.

## The two collisions, recorded rather than fixed

- **claude's server and ox's server both default to `8788`.**
- **All three admin dev servers default to `5173`.**

Both are **pre-existing**: running these repositories side by side before fusion already
collided in exactly this way, so fusion neither caused them nor is the occasion to fix
them. Under ADR 0050's boundary they are out of scope. What makes them survivable is the
scoped names above — `OX_SERVER_PORT=…` moves ox's server off `8788` without touching a
default, and `CLAUDE_SERVER_PORT=…` now does the same for claude's. In
practice whichever process binds second loses, which is why claude's admin sets
`strictPort` and says so rather than sliding to `5174`.
