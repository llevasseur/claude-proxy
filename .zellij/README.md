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
create, and renumbering would itself be the runtime change that campaign forbade.

**One number has moved since, and exactly one.** ADR 0062 took ox's server from `8788` to
`8808` — beside ox's own proxy on `8807` — because ADR 0041's provider picker needs
claude's and ox's servers bound *at the same time*, in a checkout nobody has configured.
That amends 0050's "change none of these numbers" for this single default and leaves the
rest of 0050 governing, so the sentence above still holds for the other eight.

| stack | proxy | server | admin |
|---|---|---|---|
| claude | 8787 | 8788 | 5173 |
| codex | 8026 | 4319 | 5173 |
| ox-alpha | 8807 | 8808 | 5173 |

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
as it is launched today resolves exactly as it did, and ADR 0050 now describes this
repository rather than a state it had not reached. **Eight of the nine defaults are the
ones fusion found**; ox's server is the one that moved, under ADR 0062, and it moved by
changing the number rather than by leaning on the scoped name.

**claude's proxy and server validate nothing, and that is the one asymmetry worth
knowing.** Neither package had a config module at all before ticket 22: `Number()` of a
bad value yields `NaN` and `listen` decides. The siblings all range-check and throw, and
adopting that check would have turned a launch that works today into one that throws —
the runtime change ADR 0050 exists to avoid. So claude's two took the siblings'
*resolution order* and left the parsing alone, which is why claude's proxy has three
port cases in `stacks/claude/proxy/config.test.ts` where codex's proxy has four: the
fourth asserts a rejection claude deliberately does not perform.

## The collisions: one fixed, one still recorded

- **The two servers no longer collide.** claude's stays on `8788` and ox's is on `8808`.
- **All three admin dev servers still default to `5173`.**

Both started out **pre-existing** — running these repositories side by side before fusion
already collided in exactly these two ways — and under ADR 0050's boundary both were out
of scope, survivable because the scoped names made them overridable.

**What changed for the servers is what the collision costs.** While nothing needed two
servers up at once, an override was a sufficient answer. ADR 0041's provider picker asks
one dashboard to read all three, so the collision stopped being awkwardness and started
being a default checkout that cannot work; by 0050's own boundary test it became
campaign-caused and in scope. ADR 0062 moved ox's default rather than claude's, the
smaller blast radius of the two, and `OX_SERVER_PORT=8788` still puts it back for anyone
who wants the old number.

**The admin collision stands, and deliberately.** The picker does not require three
dashboards up at once, so nothing has made it campaign-caused. In practice whichever
process binds second loses, which is why claude's admin sets `strictPort` and says so
rather than sliding to `5174`.
