# Repository Agent Instructions

## Repository map

Read this instead of walking the tree. This is one pnpm workspace holding **three
stacks** — three proxies that were separate repositories until the `monorepo-fusion`
campaign absorbed them, each still its own set of packages under `stacks/<name>/`:

| Stack | Path | Packages | What it proxies |
|---|---|---|---|
| claude | `stacks/claude/` | `proxy`, `server`, `core`, `admin` | Anthropic / Claude Code |
| codex | `stacks/codex/` | `proxy`, `server`, `packages/core`, `apps/admin` | OpenAI |
| ox-alpha | `stacks/ox-alpha/` | `proxy`, `server`, `packages/core`, `apps/admin` | OpenAI Responses |
| net | `stacks/net/` | `server` | Internet wire-byte spend over its own SQLite corpus; proxies nothing |

The net stack's hourly collector is a timer inside its server process, not a second
process — a LaunchAgent or any always-on machine-side component is deliberately out of
scope ([decision internet-spend 005](docs/wayfinder/decision-internet-spend-005-collector-residency.md)),
so data exists only while net-server runs.

Every package is scoped `@agent-proxy/<stack>-<package>` — `@agent-proxy/claude-server`,
`@agent-proxy/codex-proxy`, `@agent-proxy/ox-core`. Bins are untouched by that scoping.

**Only claude's stack is flattened.** `pnpm-workspace.yaml` carries `stacks/*/packages/*`
and `stacks/*/apps/*` for the other two, because flattening codex would break its
`../scripts/run-if-present.mjs` paths and, more seriously, the `import.meta.dirname/../..`
anchor ADR 0054 turns on. Do not "tidy" the asymmetry — it is load-bearing.

`ox-alpha` is a clean-room rebuild of `codex-proxy` from its recorded decisions, so the
two look alike on purpose. Where a plan under-specifies a concrete mechanic — pricing
rates, Responses SSE usage selection, recordId generation, DST boundaries — ox ports the
codex mechanic faithfully and cites it. Where neither docs nor code settles a genuine
choice, it records an unratified needs-human decision rather than picking silently.

### Inside the claude stack

- `stacks/claude/server/src/server.ts` dispatches on pathname; the `build*` handlers
  behind those routes live in `stacks/claude/server/src/api.ts`. CLI entry points are
  `suggestions-cli.ts` (`pnpm --filter @agent-proxy/claude-server suggestions`),
  `daily-summary.ts`, `chat-cli.ts`, `maintain-cli.ts`, and `ingest-cli.ts`; the SQLite
  substrate lives under `stacks/claude/server/src/db/`.
- **Each page in `stacks/claude/admin/src/routes/<name>.tsx` declares its own route.** The
  file exports its component as before, plus `route` — its own `createRoute` call,
  carrying path, component, `staticData.title` and any `validateSearch` — and, if it
  belongs in the side rail, `nav`, its station. There is still **no** file-based routing
  and no generated route tree: `routes/registry.ts` is a hand-written list of the 38
  modules, so a new page is a new file in `routes/` plus one line there. `router.tsx` is
  ~20 lines — it imports that list and calls `addChildren`; the root route and the layout
  live in `route-root.tsx`, which builds the rail from the same list. Three things there
  are load-bearing rather than style: `ROUTES` and the rail's `STATIONS` are `as const` (a
  plain array literal widens to a union array and the route tree loses which paths exist,
  which silently degrades `<Link to>` and `useParams({ from })`); a `nav` is written
  `as const satisfies NavEntry`, never `: NavEntry`, for the same reason; and the import
  cycle between `registry`, the page files and `route-root` is deliberate and benign,
  since every edge is read lazily. Section order lives in `NAV_SECTION_ORDER` in
  `routes/nav.ts` and station order is the registry's own order, so a page in no section
  simply exports no `nav`. Shared UI is `components/`, data fetching is `src/api.ts` +
  `useLiveQuery.ts`.
- `stacks/claude/core/src/` is one file per domain (`sessions.ts`, `suggestions.ts`,
  `usage-limits.ts`, …) re-exported from `index.ts`.
- `stacks/claude/proxy/` is TypeScript with **zero runtime dependencies** — `proxy.ts`
  (bin `claude-proxy`), plus `wire.ts`, `session.ts`, `skim.ts`, `system-prompt.ts`,
  `usage-live.ts`.
- `logs/` at the repository root holds roughly today only: per-request triples
  (`<timestamp>_anthropic.audit.json` / `.md` / `.request.txt`),
  `logs/sessions/<threadId>.md` transcripts with `.nodes.jsonl` and `.state.json`
  sidecars, `logs/suggestion-status.json`, `logs/.chat/`, and `logs/archive/`.

### Rules that hold for every stack

- **No core package has a build, and no proxy has one either.** Each core's `exports` map
  points straight at `./src/index.ts`, so consumers import TypeScript source and no
  `dist` ever exists. Each proxy is executed directly by node, which strips the types
  itself. Imports carry explicit `.ts` extensions (`allowImportingTsExtensions`) — that is
  deliberate, not a mistake to "fix". **Install is the whole build**, so
  `ERR_MODULE_NOT_FOUND` means a worktree was never bootstrapped, never that something
  needs compiling.
- Keep every proxy and every core free of runtime dependencies.
- Keep core deterministic: no Node modules, no environment, clock, filesystem, database or
  network reads.
- Treat final sanitized audit sidecars as the source of truth and SQLite as rebuildable
  state.
- Never persist request bodies, response bodies, prompts, tool data, credentials, cookies,
  or arbitrary headers.
- Node 22.18 or newer, pnpm 11.5.2.
- Tests sit beside their package, never in a top-level `test/`: vitest for the servers and
  cores, `node --test` for the proxies. claude's admin has no test suite — `typecheck` is
  its only gate.

## Ports

Nine defaults — three stacks by proxy, server and admin. **`.zellij/README.md` is the
full record**, including which environment variable each one reads and where the default
is written; the summary is:

| stack | proxy | server | admin |
|---|---|---|---|
| claude | 8787 | 8788 | 5173 |
| codex | 8026 | 4319 | 5173 |
| ox-alpha | 8807 | 8788 | 5173 |

**Change none of these numbers.** ADR 0050 struck "allocate nine distinct ports": it was a
remedy for a collision fusion did not create, and renumbering would be exactly the runtime
change the campaign forbids.

**All six of ADR 0050's scoped names now exist**, so the ADR describes this repository
rather than an intent it has not reached. `CODEX_SERVER_PORT`, `OX_PROXY_PORT` and
`OX_SERVER_PORT` arrived with the absorption tickets; ticket 22 added the remaining
`CLAUDE_PROXY_PORT`, `CLAUDE_SERVER_PORT` and `CODEX_PROXY_PORT`. Each keeps its bare
name as a fallback scoped to its own package — `PORT` for both claude packages,
`PROXY_PORT` for codex's proxy — so a stack launched exactly as it is launched today
resolves exactly as it did, and no default moved.

**claude's proxy and server validate nothing, and that is deliberate.** Neither package
had a config module at all before ticket 22, so `Number()` of a bad value has always
yielded `NaN` and left `listen` to decide. Adopting the siblings' range check would have
turned a launch that works today into one that throws — the runtime change ADR 0050
exists to avoid — so claude's two took the siblings' *resolution order* and left the
parsing alone. That is why `stacks/claude/proxy/config.test.ts` carries three port cases
where `stacks/codex/proxy/test/config.test.ts` carries four: codex's fourth asserts the
rejection claude deliberately does not perform.

Two collisions are **recorded rather than fixed**, because both predate fusion — running
these repositories side by side already collided this way: claude's and ox's servers both
default to `8788`, and all three admin dev servers to `5173`. The scoped names above are
what makes them overridable without moving a default.

## Toolchain

- Verify with `my-command-tools verify`; it discovers and runs the root `typecheck`,
  `test`, `build`, `check`, `lint`, `check:env` and `check:names` scripts. `check` is
  Biome (`biome check .` — lint plus format plus import sorting, read-only) plus
  `scripts/check-package-filters.mjs`; `format` (`biome check --write .`) is the fixer and
  `lint` (`biome lint .`) narrows to the linter alone. `anti:slop` is oxlint.
- Biome is configured by `biome.json` at the repo root, pinned to **2.5.6**. Two things
  there are deliberate and should not be "tidied" away:
  - The `files.includes` entry `!**/logs` prunes the log directories. They hold captured
    audit JSON with non-UTF-8 bytes, and the pattern is doubly-starred so it matches a
    stack's log directory as well as the root one. **The older note here claimed `!logs`
    prunes while `!logs/**` still walks — on 2.5.6 that distinction does not exist: ticket
    02 measured both forms against a directory holding invalid UTF-8 and a deliberately
    unreadable file, and both pruned it, with no UTF-8 errors and no permission error.**
    The pattern shipped is the one that is documented to prune and measured fastest (364
    files in 51ms). Treat that as a fact about 2.5.6 specifically and re-measure before
    trusting it across a Biome upgrade — the reason it is written down with its version is
    that the previous version of this note went stale silently and was defended by readers
    who had no way to know.
  - `style/noNonNullAssertion` is **off**. It fired at 255 sites, essentially all of them
    the direct consequence of `noUncheckedIndexedAccess` being on repo-wide — the
    assertion is how an already-bounds-checked index access is narrowed. `biome.json` is
    strict JSON and cannot carry a comment saying so, which is why it says so here.

  Everything else is suppressed per site with a stated reason rather than turned off;
  prefer that when a new rule fires on deliberate code.
- `biome.json` loads one GritQL plugin, `stacks/claude/admin/lint/no-bare-size.grit`. It
  refuses a bare px in a `padding`, `margin`, `gap`, `font-size` or `border-radius`
  declaration, because those name a step of the space, type and radius scale in
  `stacks/claude/admin/src/styles/tokens.css`. If it fires, pick a step
  (`var(--space-N)`, `var(--text-N)`, `var(--radius-N)`) rather than suppressing — and if
  no step fits, add a *named* token beside `--space-page`, since a size one rule reaches
  for still wants a name.
  **It cannot be scoped to one stack, and two tickets established that separately.**
  `plugins` is a top-level array applying repo-wide, and the path in it says only where
  the plugin *file* lives, not what it inspects; Biome 2.5.6 supports neither
  `overrides[].plugins` nor plugin suppression comments. So the header's premise — the
  dashboard sheet is the only CSS in the repo — stopped being true at fusion and stays
  false; there are three sheets. The sibling stacks' sheets are checked too, and their few
  bare-px sites are rewritten against a named token that sheet already declares rather
  than exempted: codex's `margin: -1px` became `calc(-1 * var(--space-1))`, and ox's two
  `border-radius: 999px` became `var(--radius-pill)`. That is the remedy for a new one; do
  not reach for a scoping mechanism, because none exists in the pinned version.
- **ox is at a `warn` tier under both linters, and the tier is a countdown rather than an
  exemption.** The `stacks/ox-alpha/**` block in `biome.json` `overrides` holds the three
  rules that fired on ox source when it was absorbed — `noEmptyBlockStatements` (9),
  `noArrayIndexKey` (4) and `noUnusedVariables` (1) — at `warn` instead of `error`,
  because the campaign that absorbed ox forbids changing its runtime behaviour and each of
  those fixes would. `stacks/ox-alpha/.oxlintrc.json` does the same for the anti-slop
  rules, which start at 358. codex extends the root oxlint config and restates **7** of
  the anti-slop rules at `warn` — the tier it enforced on itself before the merge, now
  naming only the rules that still fire. **ADR 0051 covers codex as well as ox**: it was
  amended to carry codex explicitly, with per-rule counts, ox's ratchet, and ox's expiry
  at the end of campaign 3.
  Ticket 24 measured codex at root severity — 123 diagnostics across 19 files, on 7 of
  the 15 rules — kept the tier, and applied the ratchet immediately: the 8 rules firing
  zero times came out of the restatement and inherit the root's `error`, so that 7-rule
  list is now the counter. **The tier survived the measurement because clearing it is
  not a lint fix.** 69 of the 123 sit on rules whose only remedy is parsing input at an
  I/O boundary, or replacing an `unknown`/open-dictionary type with a domain type — both
  change what codex does with malformed input, which is the runtime change this campaign
  forbids, and the same ground on which ADR 0051 already rejected ox's
  `useExhaustiveDependencies` fixes.
  Two further findings, `noUnusedImports` (3) and `noBarrelFile` (1), are already `warn`
  repo-wide and are deliberately **not** in the block — putting them there would fake a
  ratchet, since removing them from it could never tighten anything.
  `useExhaustiveDependencies` was expected among them and fires zero times on ox, so it
  stays at `error`.
  **The ratchet, which is the whole point of the tier: a rule moves from `warn` back to
  `error` once its count reaches zero, and every file a ticket touches must pass at
  `error` before that ticket is done.** That is what makes the backlog shrink
  monotonically instead of drifting. `off` is never the answer here — `off` is invisible,
  `warn` is a countdown. The block is expected to be empty by the end of campaign 3;
  `biome.json` is strict JSON and cannot carry a comment saying so, which is why it says
  so here.
- `.gitattributes` exists for exactly one line, `CHANGELOG.md merge=union`, and it is
  load-bearing rather than tidy-up. Nearly every commit here touches `CHANGELOG.md`, and
  every one of them **prepends** — so two branches in flight always edit the same first
  lines and the three-way merge conflicts every single time, in the identical place, with
  no semantic disagreement to resolve. `union` takes both sides' added lines instead of
  raising a conflict, which makes the conflict impossible rather than merely quick to
  resolve. It is safe **because of what this file's format already is**: one bullet per
  entry on its own line, and `### Added` / `### Changed` / `### Fixed` headings that
  already repeat down the file, so a duplicated heading is the shape the file has rather
  than damage.
  Three consequences to keep in mind. `union` is per-file and per-line: it applies to
  `CHANGELOG.md` alone, never to code, where "keep both sides" would be a silent wrong
  answer. It resolves without asking, so a branch that *rewrites* an existing entry rather
  than adding one gets both versions — re-read the top of the file after a merge if you
  edited an entry in place. And **the pattern has no slash, so it matches at any depth**;
  that is deliberate and the file's own comment records why. No stack brought a changelog,
  so this repository has exactly one, at the root, and the widening is real in mechanism
  and empty in practice. A sibling changelog added later inherits union-merge silently —
  if it is not shaped like this one, anchor the pattern to `/CHANGELOG.md` then.
  When a release is eventually cut and `## [x.y.z]` headings appear, revisit this: the
  guarantee above rests on `## [Unreleased]` being the only release heading.
- **`.git-blame-ignore-revs` lists the commits `git blame` should look through, and it
  does nothing until this clone is told to read it:**

  ```
  git config blame.ignoreRevsFile .git-blame-ignore-revs
  ```

  Run that once per clone. `blame.ignoreRevsFile` is a config key, and git config is
  per-clone rather than per-tree, so unlike `.gitattributes` above the file cannot carry
  its own activation — committing it is only half the mechanism, and the half that is
  committed is the inert one. `scripts/bootstrap-worktree.sh` runs the command, which
  covers this clone's worktrees **and its main checkout too**, since linked worktrees
  write to the shared config rather than to one of their own. A clone that has never
  bootstrapped a worktree still needs the line above by hand, and the symptom of skipping
  it is silent: blame works, it just reports the wrong commit.
  The file currently holds one SHA, the commit that reformatted all 96 of ox's source
  files to this repository's Biome settings. Nothing about that commit is worth blaming,
  and without the config every one of those files blames to it. Only ever add a commit
  that changed no behaviour — a commit mixing a reformat with a real edit makes the real
  edit unblameable.
  **One sharp edge, until this file reaches `main`.** The config is per-clone but the file
  is per-branch, and git treats a missing ignore list as fatal rather than as nothing to
  ignore — so on a branch cut before this file existed, every `git blame` in the clone
  dies with `fatal: could not open object name list: .git-blame-ignore-revs`. That is the
  config finding no file, not damage: either `git config --unset blame.ignoreRevsFile`
  until you are back on a branch that has it, or merge forward. The window closes on its
  own once the file is on `main` and every branch is cut from it.
- **Project skills are tracked under `.agents/skills/<name>/`, and `.claude/skills/` is
  gitignored.** That directory is only the path Claude Code discovers skills at, so it
  holds symlinks rather than content and is rebuilt per checkout by
  `scripts/link-project-skills.sh` — wired into `postinstall` and into
  `scripts/bootstrap-worktree.sh`, which is what makes the skills reachable from a
  worktree. Add or edit a skill under `.agents/skills/`; a new one is surfaced by the next
  install, or by `pnpm skills:link` now. The link is relative
  (`../../.agents/skills/<name>`), so each checkout resolves to its own branch's skills
  rather than back to the main checkout's.
- `docs/` is an OKF bundle declared in `docs/index.md` frontmatter — `docs/features/`,
  `docs/specs/`, `docs/adrs/`, `docs/roadmap/` (the delivery ladders both siblings
  brought), `docs/wayfinder/`, and `docs/history/` (commit maps from the
  absorbed repositories; data files rather than concepts, so okq does not index them). Go
  there for depth rather than re-deriving it from source.

## Running everything

`pnpm zellij` opens one stack's proxy, server and admin in a single zellij session, plus a
spare shell tab. **All three layouts live in the root `.zellij/`** — `claude-proxy.kdl`,
`codex-proxy.kdl`, `ox-alpha-proxy.kdl` — because each stack's `scripts/zellij.sh` resolves
the repository top level and `cd`s there before asking for `.zellij/<stack>.kdl`, which
after fusion is the monorepo root. The two sibling layouts pin `cwd` per pane so a bare
`pnpm proxy` reaches that stack's script rather than the root one, which is claude's. See
`.zellij/README.md`.

Individually, from a stack directory: `pnpm proxy`, `pnpm server`, `pnpm admin`.

Relative paths in a stack's `.env` — `AUDIT_DIR`, `DATABASE_PATH`, `PROXY_STATUS_FILE`,
`PROXY_STATUS_PATH` — resolve against that stack's root rather than against the launching
cwd or the monorepo root, so every pane writes to the same place however it was started.
Absolute values still win. See ADR 0054.

## Efficient discovery

- **Before issuing a read-only call, name every other read-only call whose target
  you already know, and send them in the same block.** "I'll read this, then decide
  what to read next" is the defect: if the next target does not depend on this
  result, it was already known and belongs in this block. Reads, `rg`, `rg --files`,
  `ls`, and read-only `git` inspections all batch together.
- **The trip-wire: four or more consecutive read-only calls with no decision between
  them is a defect**, and it is counted as one. On the third such call in a row,
  stop and ask what the remaining unknowns are — then issue them at once. Anything
  that gates the next read (a path you must confirm exists first) is a real
  dependency and does not count; "I read them one at a time to stay tidy" is not.
- **The per-file loop is what actually trips the trip-wire.** One call per entry of a
  list you already hold — a `Read` per changed file, or a
  `git diff origin/main:<path> HEAD:<path>` per path — is the review workflow, and it
  is the clearest case the rule above governs: the file list came back in one call, so
  every read in the loop was known before the first one went out. Reviews recorded
  runs of twelve. Send the whole list as one block of `Read`s, and for a diff ask for
  every path at once (`git diff origin/main...HEAD -- <path> <path> …`) rather than
  re-invoking `git diff` per path.
- **Hand a fan-out to one search agent** when the answer needs sweeping many files or
  directories, or when you cannot name the targets up front — ask for the conclusion,
  not the file dumps, and keep only that. Batch directly instead when the target
  files are already known; a search agent for three known paths costs more than it
  saves.
- Before the first `Edit` of an existing file in a session — or the first `Write`
  that overwrites one — read that target with the `Read` tool; inherited context
  and shell output do not satisfy either tool's read-before-write precondition.
  This is a **tool precondition, not a reason to re-read**: it is satisfied once per
  file per session, and the rule below governs every read after it. These
  preconditions are repository-wide rather than task-command specific: the same
  avoidable tool failures recur in ordinary and god-mode sessions.
- **A file already read this session is already in context — do not read it again.**
  Re-reading pays for the same bytes twice and pushes the cache out. The only
  re-read is after the file actually changed (your `Edit`, a hook, formatter,
  generator, external process, or another agent), and then only the affected range
  via numeric `offset`/`limit` — never the whole file.
- **"I need a different symbol from it" is not a reason to re-read.** Going back to a
  file already in the transcript because the interesting function is now a different
  one is what puts a file at three, four, or five reads — the claude server's
  `src/api.ts` and its `admin/src/routes/` files are the recorded repeat offenders,
  being large enough that each pass is expensive. Locate both symbols in one
  `rg -n 'foo|bar' <file>`, then pull only the range you still need with numeric
  `offset`/`limit`. The file's earlier read is still in context; the second full read
  buys nothing it did not already have.
- **Do not re-read to verify an `Edit` that returned success.** `Edit` and `Write`
  fail loudly when they do not apply; a successful result *is* the verification, and
  the harness already tracks the new contents. Verify behaviour with the repo's
  gates, not with a confirmation read.
- Pass `Read`'s `offset` and `limit` as integers, never strings. `pages` is a
  string page range (`"1-5"`) and stays a string. Prefer a targeted numeric slice
  when the whole file is unnecessary.
- Prefer `rg` and `rg --files` over recursive `grep`, `find`, or multi-directory
  `ls` probes. When no match is an acceptable discovery result, make that explicit
  for that read-only search (`rg ... || true`). Confirm an optional path exists
  before listing a directory or reading, `sed`-ing, or otherwise transforming a
  file, so an absent path does not turn useful discovery into a failed tool result.

## Shell command forms

Bash is where roughly two thirds of failed tool calls come from, and nearly all of
them are one of the shapes below. Each has a working form; use it the first time.

- **Never `cd` into a package by relative path.** `cd server`, `cd apps/admin`, and
  `cd packages/core` fail with `(eval):cd:1: no such file or directory: server`
  whenever the shell is not already at the right root — which is the normal case in a
  worktree, and now also the normal case anywhere, since every package sits under
  `stacks/<name>/`. Run package scripts from wherever you are with
  `pnpm --filter @agent-proxy/<stack>-<proxy|server|core|admin> <script>` — the filter
  argument is the package's **scoped** name, and pnpm answers an unscoped one with a
  warning and exit 0 rather than an error. Point the helper at a root with
  `my-command-tools <verb> --cwd <absolute path>` (the flag goes **after** the verb;
  before it the helper just prints usage), and use `git -C <absolute path>` for git. If a
  directory genuinely must be entered, enter it by absolute path.
- **Every path argument is absolute.** `cat components/SeriesLineChart.tsx` fails
  with `No such file or directory` because the file is at
  `stacks/claude/admin/src/components/SeriesLineChart.tsx` relative to a root the shell is
  not in. Prefer the `Read` tool over `cat`/`head`/`sed` for reading; when a shell
  command must take a path, spell it out in full from the worktree root.
- **`sed` over `logs/` needs `LC_ALL=C`.** Captured request/response bodies contain
  non-UTF-8 bytes, and BSD `sed` under a UTF-8 locale aborts with
  `sed: RE error: illegal byte sequence`. Prefix `LC_ALL=C` for any `sed`/`grep`
  pass over log or audit files. For editing tracked source, use the `Edit` tool
  rather than `sed -i` at all.
- **Give a long command an explicit timeout up front.** `Command timed out after
  2m 0s` is the default ceiling, and a retry hits it again — raise Bash's `timeout`
  on the first call for installs, full test runs, and `my-command-tools verify`.
  Never run a dev server or watcher in the foreground; start it in background mode
  with a log file and wait on the log.
- **Piping a workspace script's `--json` into a parser needs `pnpm --silent`.** The
  form that parses is
  `pnpm --silent --filter @agent-proxy/claude-server suggestions list -r 9 --json`,
  with `--silent` **before** `--filter`. pnpm's script runner wraps the script's own
  output in lines of its own — a dimmed `$ tsx src/suggestions-cli.ts …` echo, and a
  `Scope: … workspace projects` banner when the filter matches more than one package
  — and which stream they land on is pnpm's choice, not the script's: current pnpm
  puts them on stderr, older ones put them on stdout. So `… --json | jq` and
  `… --json 2>&1 | node -e …` both fail with `SyntaxError: Unexpected token 'S',
  "Scope: all"…`, which is a recorded failure rather than a hypothetical one. Do
  **not** work around it by stripping the banner (`sed -n '/^{/,$p'`) — `--silent`
  empties both streams of pnpm's own output and suppresses nothing of the script's:
  its stdout, its stderr and its exit code are untouched, so a usage error still
  reaches you with its exit 1. The same applies to every `pnpm --filter … --json`
  invocation here, `ideas` included.
- **`my-command-tools pr` requires both `--title` and `--body`.** Omitting either
  exits 2 with `{"error": "--title is required"}` — a usage error, not a transient
  failure, so re-running the same command fails identically. The form is
  `my-command-tools pr --title <text> --body -` with the description on stdin.
- The shell is zsh, where an unmatched unquoted glob aborts the whole command
  (`no matches found`). Quote every pattern the invoked program should expand, and
  prefer `rg -g '<pattern>'` / `rg --files -g '<pattern>'`; `grep --include=*.ts`
  fails here, `rg -g '*.ts'` is the working form.
- Do not read `@{u}` on a branch that may never have been pushed. Push with `-u`
  first, or tolerate the missing upstream explicitly.

## Environment-specific failures

- **`ERR_MODULE_NOT_FOUND` in a fresh worktree means it was never bootstrapped — not
  that something needs building.** `git worktree add` materializes tracked files
  only, so there is no `node_modules/`, no `.env`, no `logs/` and no
  `.claude/skills/`. Fix it once with `bash scripts/bootstrap-worktree.sh` (run from
  inside the worktree; it symlinks env files and `logs/` from the main checkout,
  rebuilds `.claude/skills/`, sets `blame.ignoreRevsFile`, then runs
  `pnpm install --frozen-lockfile`). **Its env link list now names the post-relocation
  paths `stacks/claude/admin/.env` and `stacks/claude/proxy/.env`**; until ticket 23 it
  still named the pre-fusion `apps/admin/.env` and `proxy/.env`, which had linked nothing
  since the stack moved. That failure was silent by construction — the script skips a
  source it cannot find and says only `skip … (not in main checkout)` — so read its
  output rather than assuming env arrived. It links no `stacks/claude/server/.env`, and
  never has: that gap predates fusion, so under ADR 0050's boundary it is pre-existing
  awkwardness rather than a fusion-caused regression, and it is left alone deliberately.
- **Never wait on a core package build — there isn't one for any stack.** Each core's
  `exports` map points at `./src/index.ts`, none has a `build` script, and nothing in
  the repo references a `dist`. `No such file or directory` for a core `dist` is the
  expected answer at any time, never a signal to build; install *is* the whole build.
  A missing `logs/` directory is the same bootstrap symptom, not data loss.
- **`fatal: 'main' is already used by worktree at ...`** — `main` is checked out in
  the main checkout, so no worktree may check it out again. Never branch a task off
  a local `main` checkout; create the task branch with
  `my-command-tools worktree begin --branch <type>/<summary>`, which branches off
  `origin/main` without checking `main` out anywhere.
- **`error: the branch '<name>' is not fully merged`** — `git branch -d` refuses a
  branch whose commits are not on the target. It is a question, not an obstacle:
  confirm the work reached origin (`my-command-tools state`, compare `head` against
  `origin/<branch>`) or that the PR merged, and only then delete. Re-running the
  same `-d` fails identically, and escalating to `-D` discards the commits — if it
  refuses twice, surface it instead of forcing.
- `1Password: failed to fill whole buffer` with `fatal: failed to write commit
  object` is an unapproved signing prompt, not a repository problem: the commit did
  not happen and the tree is untouched. Retry the same commit once after the prompt
  is approved. Never rewrite the commit, pass `--no-gpg-sign`, or change the repo's
  signing configuration to get around it.
- `gh`'s GraphQL-backed writes (`gh pr create`, `gh pr edit`) resolve to an account
  that is not a collaborator on `llevasseur`-owned repos, while REST succeeds. A
  `must be a collaborator` GraphQL error means the wrong identity, not a permission
  to request: select the right account (`my-command-tools identity --select`) or use
  the REST equivalent.

## Worktree ownership

- **This exact error is the one that keeps recurring:**

  ```
  This session is not the owner of the worktree at
  /Users/llevasseur/Documents/ghub/claude-proxy/.claude/worktrees/<name>
  ```

  It comes from the session worktree tool (`ExitWorktree`, and `EnterWorktree` on
  the same path). It is a **statement about provenance, not a transient failure**:
  the worktree was created by `my-command-tools worktree begin` or `git worktree
  add`, so the session tool will never own it, and calling it a second time returns
  the identical error. **The second call is the entire cost — do not make it.** One
  occurrence, then switch mechanisms.
- **The replacement, in order.** Step out with `ExitWorktree({action: "keep"})` if
  the session is inside it, then from **outside** the target directory:

  ```
  git worktree list --porcelain          # confirm path, and that it is not `locked`
  my-command-tools worktree end --branch <branch>   # preferred: re-verifies origin
  git worktree remove <exact-absolute-path>         # only if the above does not apply
  ```

  `worktree end` refuses when `HEAD` has not reached origin — push, do not force.
  If it refuses because another live session holds the worktree, stop and report the
  path as left in place.
- **A compacted or continued session has no memory of how the worktree was made, and
  must not guess.** If the transcript opens with "This session is being continued
  from …", assume nothing about ownership: run `git worktree list --porcelain` first
  and treat every worktree it lists as externally created, because the ones under
  `.claude/worktrees/` in this repo are. Re-derive provenance from that output — the
  absence of a creation record is not evidence the session created it.
- Before any removal, check locked state, uncommitted changes, and unpushed commits,
  and run the cleanup from outside the target worktree.

## Classifier-sensitive calls

A refusal here is a judgement about the **shape of the command, not the permission
behind it**. Every refusal on record was a step the agent had already decided to
take, so it cost a turn and a retry rather than preventing any work — and the same
intended operation succeeded once it was reissued as the smallest bare command.
Three shapes account for all of them; recognize them before sending, not after.

- **A read-only inspection captured into `$(...)`.** `BASE=$(git merge-base
  origin/main HEAD)` and `d=$(ls logs/archive | sort | tail -1)` were both refused,
  though `git merge-base` and `ls` are unremarkable run bare. A command substitution
  or assignment wrapper obscures the probe inside it. Run the probe bare, read the
  value off its output, and write that value literally into the next call.
- **An inspection chained in the same call as a mutation.**
  `ls -la logs/claude-proxy.db* 2>/dev/null; mv logs/claude-proxy.db "$…/tmp/…bak"`
  is refused as a unit, because the `ls` cannot be judged apart from the `mv` it is
  glued to. Split it: the `ls` is a read-only call, the `mv` is a second call. This
  generalizes the branch-lifecycle bullet below — never let a probe ride along with
  the mutation it was checking for.
- **A long process launched with a trailing `&` plus `sleep` in a foreground call.**
  `pnpm --filter @agent-proxy/claude-server start > srv.log 2>&1 & sleep 12;
  grep -iE "listening|error" srv.log` is refused, and re-sending it fails again since a
  foreground `sleep` is independently blocked. The supported form is the Bash tool's own
  `run_in_background` with a log file, then a bounded wait on that log (`Monitor`, or
  an until-loop) and a separate call to read it — the same background-plus-log shape
  "Give a long command an explicit timeout up front" already requires.
- As a narrow exception to the general rule to chain dependent mutations, issue
  branch-lifecycle operations such as checkout/switch, pull, remote-branch
  inspection, and local branch deletion as individual shell calls. Put status
  output, pipes, and follow-up verification in separate read-only calls.
- A classifier refusal is not evidence that repository protections should be
  weakened. Inspect the refused command first; when the intended operation is safe
  and the refusal looks incidental to the command's shape — an over-broad chain,
  pipe, or extra flag — retry only the smallest exact command, never an allowlisted
  Bash pattern or a permission-settings change.
- A refusal of a **PR merge or a remote-ref deletion is final.** Surface it to the
  human and carry on with the rest of the work. Re-expressing the same operation is
  refused for the same reason and costs a second turn:
  `gh api -X PUT .../pulls/N/merge` is `gh pr merge`, and
  `gh api --method DELETE .../git/refs/heads/...` is `git push origin --delete`, so
  neither is the narrow retry the bullet above permits — nor is re-running one under
  `GH_TOKEN=...`.
