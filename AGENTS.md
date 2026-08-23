# Repository Agent Instructions

## Repository map

Read this instead of walking the tree. Four pnpm workspace packages: `proxy/` (the
logging proxy, bin `claude-proxy`), `server/` (HTTP API plus headless jobs),
`packages/core/` (`@claude-proxy/core`, pure logic, no runtime deps), `apps/admin/`
(React/TanStack dashboard).

- `server/src/server.ts` dispatches on pathname; the `build*` handlers behind those
  routes live in `server/src/api.ts`. CLI entry points are
  `server/src/suggestions-cli.ts` (`pnpm --filter @agent-proxy/claude-server suggestions`),
  `daily-summary.ts`, `chat-cli.ts`, `maintain-cli.ts`, and `ingest-cli.ts`; the
  SQLite substrate lives under `server/src/db/`.
- **Each page in `apps/admin/src/routes/<name>.tsx` declares its own route.** The file
  exports its component as before, plus `route` — its own `createRoute` call, carrying
  path, component, `staticData.title` and any `validateSearch` — and, if it belongs in
  the side rail, `nav`, its station. There is still **no** file-based routing and no
  generated route tree: `apps/admin/src/routes/registry.ts` is a hand-written list of
  the 38 modules, so a new page is a new file in `routes/` plus one line there.
  `apps/admin/src/router.tsx` is now ~20 lines — it imports that list and calls
  `addChildren`; the root route and the layout live in `apps/admin/src/route-root.tsx`,
  which builds the rail from the same list. Three things there are load-bearing rather
  than style: `ROUTES` and the rail's `STATIONS` are `as const` (a plain array literal
  widens to a union array and the route tree loses which paths exist, which silently
  degrades `<Link to>` and `useParams({ from })`); a `nav` is written
  `as const satisfies NavEntry`, never `: NavEntry`, for the same reason; and the
  import cycle between `registry`, the page files and `route-root` is deliberate and
  benign, since every edge is read lazily. Section order lives in `NAV_SECTION_ORDER`
  in `apps/admin/src/routes/nav.ts` and station order is the registry's own order, so a
  page in no section simply exports no `nav`. Shared UI is
  `apps/admin/src/components/`, data fetching is `src/api.ts` + `useLiveQuery.ts`.
- `packages/core/src/` is one file per domain (`sessions.ts`, `suggestions.ts`,
  `usage-limits.ts`, …) re-exported from `index.ts`. It ships **no build**: its
  `exports` map points straight at `./src/index.ts`, so consumers import TypeScript
  source and `packages/core/dist` never exists.
- `proxy/` is TypeScript with **zero runtime dependencies** — `proxy.ts` (bin
  `claude-proxy`), plus `wire.ts`, `session.ts`, `skim.ts`, `system-prompt.ts`,
  `usage-live.ts`.
  TypeScript is a devDependency only; the bin is executed directly by node, which
  strips the types itself, so there is no build step and no `dist`. Imports carry
  explicit `.ts` extensions (`allowImportingTsExtensions`) — that is deliberate,
  not a mistake to "fix".
- Tests sit beside their package, never in a top-level `test/`:
  `packages/core/test/*.test.ts` and `server/test/*.test.ts` (both vitest),
  `proxy/*.test.ts` (node's built-in runner, `node --test`). `apps/admin` has no
  test suite — `typecheck` is its only gate.
- `logs/` holds roughly today only: per-request triples
  (`<timestamp>_anthropic.audit.json` / `.md` / `.request.txt`),
  `logs/sessions/<threadId>.md` transcripts with `.nodes.jsonl` and `.state.json`
  sidecars, `logs/suggestion-status.json`, `logs/.chat/`, and `logs/archive/`.
- Verify with `my-command-tools verify`; it runs the root `typecheck`, `test`,
  `build`, `check`, and `check:env` scripts. `check` is Biome (`biome check .` —
  lint plus format plus import sorting, read-only); `format` (`biome check --write
  .`) is the fixer and `lint` (`biome lint .`) narrows to the linter alone.
- Biome is configured by `biome.json` at the repo root. Two things there are
  deliberate and should not be "tidied" away:
  - `!logs` in `files.includes` skips traversal of `logs/` outright. That
    directory holds captured audit JSON with non-UTF-8 bytes; `!logs/**` would
    still walk it.
  - `style/noNonNullAssertion` is **off**. It fired at 255 sites, essentially all
    of them the direct consequence of `noUncheckedIndexedAccess` being on
    repo-wide — the assertion is how an already-bounds-checked index access is
    narrowed. `biome.json` is strict JSON and cannot carry a comment saying so,
    which is why it says so here.
  Everything else is suppressed per site with a stated reason rather than turned
  off; prefer that when a new rule fires on deliberate code.
- `biome.json` loads one GritQL plugin, `stacks/claude/admin/lint/no-bare-size.grit`.
  It refuses a bare px in a `padding`, `margin`, `gap`, `font-size` or
  `border-radius` declaration, because those name a step of the space, type and
  radius scale in `stacks/claude/admin/src/styles/tokens.css`. If it fires, pick a
  step (`var(--space-N)`, `var(--text-N)`, `var(--radius-N)`) rather than
  suppressing — and if no step fits, add a *named* token beside `--space-page`,
  since a size one rule reaches for still wants a name.
  **It cannot be scoped to one stack, and two tickets established that separately.**
  `plugins` is a top-level array applying repo-wide, and the path in it says only
  where the plugin *file* lives, not what it inspects; Biome 2.5.6 supports neither
  `overrides[].plugins` nor plugin suppression comments. So the header's premise —
  the dashboard sheet is the only CSS in the repo — stopped being true at fusion and
  stays false. The sibling stacks' sheets are checked too, and their few bare-px
  sites are rewritten against a named token that sheet already declares rather than
  exempted: codex's `margin: -1px` became `calc(-1 * var(--space-1))`, and ox's two
  `border-radius: 999px` became `var(--radius-pill)`. That is the remedy for a new
  one; do not reach for a scoping mechanism, because none exists in the pinned
  version.
- **ox is at a `warn` tier under both linters, and the tier is a countdown rather
  than an exemption.** The `stacks/ox-alpha/**` block in `biome.json` `overrides`
  holds the three rules that fired on ox source when it was absorbed —
  `noEmptyBlockStatements` (9), `noArrayIndexKey` (4) and `noUnusedVariables` (1) —
  at `warn` instead of `error`, because the campaign that absorbed ox forbids
  changing its runtime behaviour and each of those fixes would.
  `stacks/ox-alpha/.oxlintrc.json` does the same for the anti-slop rules, which start
  at 358. Two further findings, `noUnusedImports` (3) and `noBarrelFile` (1), are
  already `warn` repo-wide and are deliberately **not** in the block — putting them
  there would fake a ratchet, since removing them from it could never tighten
  anything. `useExhaustiveDependencies` was expected among them and fires zero times
  on ox, so it stays at `error`.
  **The ratchet, which is the whole point of the tier: a rule moves from `warn` back
  to `error` once its count reaches zero, and every file a ticket touches must pass at
  `error` before that ticket is done.** That is what makes the backlog shrink
  monotonically instead of drifting. `off` is never the answer here — `off` is
  invisible, `warn` is a countdown. The block is expected to be empty by the end of
  campaign 3; `biome.json` is strict JSON and cannot carry a comment saying so, which
  is why it says so here.
- `.gitattributes` exists for exactly one line, `CHANGELOG.md merge=union`, and it
  is load-bearing rather than tidy-up. Nearly every commit here touches
  `CHANGELOG.md`, and every one of them **prepends** — so two branches in flight
  always edit the same first lines and the three-way merge conflicts every single
  time, in the identical place, with no semantic disagreement to resolve. `union`
  takes both sides' added lines instead of raising a conflict, which makes the
  conflict impossible rather than merely quick to resolve. It is safe **because of
  what this file's format already is**: one bullet per entry on its own line, and
  `### Added` / `### Changed` / `### Fixed` headings that already repeat down the
  file, so a duplicated heading is the shape the file has rather than damage.
  Two consequences to keep in mind. `union` is per-file and per-line: it applies to
  `CHANGELOG.md` alone, never to code, where "keep both sides" would be a silent
  wrong answer. And it resolves without asking, so a branch that *rewrites* an
  existing entry rather than adding one gets both versions — re-read the top of the
  file after a merge if you edited an entry in place. When a release is eventually
  cut and `## [x.y.z]` headings appear, revisit this: the guarantee above rests on
  `## [Unreleased]` being the only release heading.
- **`.git-blame-ignore-revs` lists the commits `git blame` should look through, and
  it does nothing until this clone is told to read it:**

  ```
  git config blame.ignoreRevsFile .git-blame-ignore-revs
  ```

  Run that once per clone. `blame.ignoreRevsFile` is a config key, and git config
  is per-clone rather than per-tree, so unlike `.gitattributes` above the file
  cannot carry its own activation — committing it is only half the mechanism, and
  the half that is committed is the inert one. `scripts/bootstrap-worktree.sh` runs
  the command, which covers this clone's worktrees **and its main checkout too**,
  since linked worktrees write to the shared config rather than to one of their
  own. A clone that has never bootstrapped a worktree still needs the line above by
  hand, and the symptom of skipping it is silent: blame works, it just reports the
  wrong commit.
  The file currently holds one SHA, the commit that reformatted all 96 of ox's
  source files to this repository's Biome settings. Nothing about that commit is
  worth blaming, and without the config every one of those files blames to it.
  Only ever add a commit that changed no behaviour — a commit mixing a reformat
  with a real edit makes the real edit unblameable.
  **One sharp edge, until this file reaches `main`.** The config is per-clone but
  the file is per-branch, and git treats a missing ignore list as fatal rather than
  as nothing to ignore — so on a branch cut before this file existed, every
  `git blame` in the clone dies with `fatal: could not open object name list:
  .git-blame-ignore-revs`. That is the config finding no file, not damage: either
  `git config --unset blame.ignoreRevsFile` until you are back on a branch that has
  it, or merge forward. The window closes on its own once the file is on `main` and
  every branch is cut from it.
- **Project skills are tracked under `.agents/skills/<name>/`, and `.claude/skills/`
  is gitignored.** That directory is only the path Claude Code discovers skills at,
  so it holds symlinks rather than content and is rebuilt per checkout by
  `scripts/link-project-skills.sh` — wired into `postinstall` and into
  `scripts/bootstrap-worktree.sh`, which is what makes the skills reachable from a
  worktree. Add or edit a skill under `.agents/skills/`; a new one is surfaced by
  the next install, or by `pnpm skills:link` now. The link is relative
  (`../../.agents/skills/<name>`), so each checkout resolves to its own branch's
  skills rather than back to the main checkout's.
- `docs/` is an OKF bundle declared in `docs/index.md` frontmatter —
  `docs/features/`, `docs/specs/`, `docs/adrs/`, `docs/wayfinder/`. Go there for
  depth rather than re-deriving it from source.

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
  one is what puts a file at three, four, or five reads — `server/src/api.ts` and the
  `apps/admin/src/` route files are the recorded repeat offenders, being large enough
  that each pass is expensive. Locate both symbols in one `rg -n 'foo|bar' <file>`,
  then pull only the range you still need with numeric `offset`/`limit`. The file's
  earlier read is still in context; the second full read buys nothing it did not
  already have.
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
  whenever the shell is not already at the repo root — which is the normal case in a
  worktree. Run package scripts from wherever you are with
  `pnpm --filter @agent-proxy/claude-<server|admin|proxy|core> <script>` — the filter
  argument is the package's **scoped** name, and pnpm answers an unscoped one with a
  warning and exit 0 rather than an error. Point the helper at a root with
  `my-command-tools <verb> --cwd <absolute path>` (the flag goes **after** the verb;
  before it the helper just prints usage), and use `git -C <absolute path>` for git. If a directory genuinely must be entered, enter it by absolute path.
- **Every path argument is absolute.** `cat components/SeriesLineChart.tsx` fails
  with `No such file or directory` because the file is at
  `apps/admin/src/components/SeriesLineChart.tsx` relative to a root the shell is
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
  form that parses is `pnpm --silent --filter @agent-proxy/claude-server suggestions list -r 9 --json`,
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
  inside the worktree; it symlinks `apps/admin/.env`, `proxy/.env`, and `logs/` from
  the main checkout, rebuilds `.claude/skills/`, then runs
  `pnpm install --frozen-lockfile`).
- **Never wait on a `@claude-proxy/core` build — there isn't one.** Its `exports`
  map points at `./src/index.ts`, it has no `build` script, and nothing in the repo
  references a `dist`. `ls: packages/core/dist: No such file or directory` is the
  expected answer at any time, never a signal to build; install *is* the whole
  build. A missing `logs/` directory is the same bootstrap symptom, not data loss.
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
  to request: select the right account (`gh auth switch`, or
  `GH_TOKEN="$(gh auth token --user llevasseur)"`) or use the REST equivalent.

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
  `pnpm --filter @agent-proxy/claude-server start > srv.log 2>&1 & sleep 12; grep -iE "listening|error"
  srv.log` is refused, and re-sending it fails again since a foreground `sleep` is
  independently blocked. The supported form is the Bash tool's own
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
