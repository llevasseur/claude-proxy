# Repository Agent Instructions

## Repository map

Read this instead of walking the tree. Four pnpm workspace packages: `proxy/` (the
logging proxy, bin `claude-proxy`), `server/` (HTTP API plus headless jobs),
`packages/core/` (`@claude-proxy/core`, pure logic, no runtime deps), `apps/admin/`
(React/TanStack dashboard).

- `server/src/server.ts` dispatches on pathname; the `build*` handlers behind those
  routes live in `server/src/api.ts`. CLI entry points are
  `server/src/suggestions-cli.ts` (`pnpm --filter server suggestions`),
  `daily-summary.ts`, `chat-cli.ts`, `maintain-cli.ts`, and `ingest-cli.ts`; the
  SQLite substrate lives under `server/src/db/`.
- `apps/admin/src/router.tsx` is the whole route table — routes are declared there
  with `createRoute` and imported from `apps/admin/src/routes/<name>.tsx`, one file
  per page. There is **no** file-based routing and no generated route tree, so a new
  page means a new file in `routes/` plus a registration in `router.tsx`. Shared UI
  is `apps/admin/src/components/`, data fetching is `src/api.ts` + `useLiveQuery.ts`.
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
- When a question needs a fan-out across many files or directories, hand it to one
  search agent and keep the conclusion instead of issuing the reads serially. Name
  the target files up front when they are already known.

## Shell command forms

Bash is where roughly two thirds of failed tool calls come from, and nearly all of
them are one of the shapes below. Each has a working form; use it the first time.

- **Never `cd` into a package by relative path.** `cd server`, `cd apps/admin`, and
  `cd packages/core` fail with `(eval):cd:1: no such file or directory: server`
  whenever the shell is not already at the repo root — which is the normal case in a
  worktree. Run package scripts from wherever you are with
  `pnpm --filter <server|admin|proxy> <script>`, point the helper at a root with
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
  only, so there is no `node_modules/`, no `.env`, and no `logs/`. Fix it once with
  `bash scripts/bootstrap-worktree.sh` (run from inside the worktree; it symlinks
  `apps/admin/.env`, `proxy/.env`, and `logs/` from the main checkout, then runs
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

## Classifier-sensitive Git calls

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
