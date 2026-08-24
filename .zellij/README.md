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
| claude proxy | `PORT` | — | `stacks/claude/proxy/proxy.ts` |
| claude server | `PORT` | — | `stacks/claude/server/src/server.ts` |
| codex proxy | `PROXY_PORT` | — | `stacks/codex/proxy/src/config.ts` |
| codex server | `CODEX_SERVER_PORT` | `PORT` | `stacks/codex/server/src/config.ts` |
| ox proxy | `OX_PROXY_PORT` | `PROXY_PORT` | `stacks/ox-alpha/proxy/src/config.ts` |
| ox server | `OX_SERVER_PORT` | `SERVER_PORT` | `stacks/ox-alpha/server/src/config.ts` |

The three admin ports are Vite's, set in each stack's `vite.config.ts`: claude pins
`5173` with `strictPort`, so it refuses to drift and fails loudly instead; codex sets
`5173`; ox sets nothing and takes Vite's own default, which is `5173` too.

**Only three of ADR 0050's six scoped names exist.** `CODEX_SERVER_PORT` (ticket 05),
`OX_PROXY_PORT` and `OX_SERVER_PORT` (ticket 06) are implemented, each keeping its bare
name as a fallback scoped to its own package. `CLAUDE_PROXY_PORT`, `CLAUDE_SERVER_PORT`
and `CODEX_PROXY_PORT` **do not exist** — claude's proxy and server both still read a
bare `PORT`, and codex's proxy a bare `PROXY_PORT`. Ticket 22 implements the missing
three; until it lands, the table above is the whole truth and ADR 0050 describes a state
this repository has not reached.

## The two collisions, recorded rather than fixed

- **claude's server and ox's server both default to `8788`.**
- **All three admin dev servers default to `5173`.**

Both are **pre-existing**: running these repositories side by side before fusion already
collided in exactly this way, so fusion neither caused them nor is the occasion to fix
them. Under ADR 0050's boundary they are out of scope. What makes them survivable is the
scoped names above — `OX_SERVER_PORT=…` moves ox's server off `8788` without touching a
default, and the same holds for claude's once ticket 22 gives it a name of its own. In
practice whichever process binds second loses, which is why claude's admin sets
`strictPort` and says so rather than sliding to `5174`.
