# monorepo-fusion-14 — Document the nine ports, merge the layouts and the agent instructions

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-14-ports-zellij-and-agents-md`
**Status:** active

## Goal

Record the nine port defaults **without changing any of them**, merge the three zellij
layouts, and produce one `AGENTS.md` for the fused repository.

## Criteria

1. **Document the nine actual defaults** — three stacks × proxy, server, admin — in
   `.zellij/` and the merged `AGENTS.md`. **Change no number.** ADR 0050 struck
   "allocate nine distinct ports": it was a remedy for a collision that is not there and
   would itself have been the runtime change the campaign's rejection rule forbids.

   | stack | proxy | server | admin |
   |---|---|---|---|
   | claude | 8787 | 8788 | 5173 (Vite default) |
   | codex | 8026 | 4319 | 5173 |
   | ox-alpha | 8807 | 8788 | 5173 |

   **Document the two real collisions rather than fixing them**: claude's and ox's
   servers both claim `8788`, and all three admin dev servers claim `5173`. Both are
   **pre-existing** — running the repositories side by side today already collides — so
   under ADR 0050's boundary they are out of scope to fix. The stack-scoped environment
   variable names from tickets 05 and 06 are what make them overridable.
2. **Merge the three `.zellij/*.kdl` layouts** into one directory, each keeping its own
   file, with the ports above wired in so a layout can start more than one stack.
3. **Merge `AGENTS.md`.** Three files become one. It must carry:
   - the repository map for the fused layout, `stacks/{claude,codex,ox-alpha}/{proxy,server,core,admin}`
   - the load-bearing toolchain notes that survive verbatim: `!logs` in
     `files.includes` and **why** (`!logs/**` still walks it; the directory holds
     non-UTF-8 audit bytes), `style/noNonNullAssertion` off and why (255 sites, all
     consequences of repo-wide `noUncheckedIndexedAccess`), `allowImportingTsExtensions`
     with `.ts` import extensions and **no build for any core package**
   - the oxlint and biome ratchet policy from ticket 08
   - the nine ports
   - the `git config blame.ignoreRevsFile` line from ticket 07
   - the corrected `pnpm --silent --filter …` invocation form with its new scoped names
   - **`history/` in the docs bundle's folder list**, which ticket 01 added and which
     `AGENTS.md` currently omits
5. **Correct the `!logs` note, which ticket 02 measured as stale.** `AGENTS.md` records
   that `!logs` skips traversal while `!logs/**` still walks the directory. On Biome
   **2.5.6 both forms prune**, so the distinction no longer discriminates on the pinned
   version. The repo ships `!**/logs` as documented-to-prune and measurably faster (364
   files in 51ms, no UTF-8 errors and no permission error against a deliberately
   unreadable directory). Rewrite the note to say what is true now and to name the
   version it was measured on — a justification that has quietly stopped holding is worse
   than none, because the next reader defends it.
4. **Settle residual risk 3 — `.gitattributes` scope.** `CHANGELOG.md merge=union` has
   **no slash**, so git matches it at **any depth**: after absorption, codex's and ox's
   own changelogs land at `stacks/<name>/CHANGELOG.md` and inherit union-merge without
   anyone deciding that.
   - `AGENTS.md` justifies union by the **specific shape** of claude's changelog — one
     bullet per line, repeating `### Added`/`### Changed` headings — and that
     justification was never checked against the other two files.
   - **Check both sibling changelogs against that shape.** Where they match, widen the
     comment to say the rule is intentional for all three. Where they do not, anchor the
     pattern to `/CHANGELOG.md` so it applies at the root only, and say why.

## Done when

`AGENTS.md` is one file describing the fused repository, `.zellij/` holds all three
layouts with correct ports, no port default changed, and the `.gitattributes` scope
decision is recorded in the file's own comment.
