# Repository Agent Instructions

## Repository map

Read this instead of walking the tree. Four pnpm workspace packages: `proxy/` (the
logging proxy, bin `claude-proxy`), `server/` (HTTP API plus headless jobs),
`packages/core/` (`@claude-proxy/core`, pure logic, no runtime deps), `apps/admin/`
(React/TanStack dashboard).

- `server/src/server.ts` dispatches on pathname; the `build*` handlers behind those
  routes live in `server/src/api.ts`. CLI entry points are
  `server/src/suggestions-cli.ts` (`pnpm --filter server suggestions`),
  `daily-summary.ts`, and `chat-cli.ts`.
- `logs/` holds roughly today only: per-request triples
  (`<timestamp>_anthropic.audit.json` / `.md` / `.request.txt`),
  `logs/sessions/<threadId>.md` transcripts with `.nodes.jsonl` and `.state.json`
  sidecars, `logs/suggestion-status.json`, `logs/.chat/`, and `logs/archive/`.
- Verify with `my-command-tools verify`; it runs the root `typecheck`, `test`,
  `build`, and `check:env` scripts.
- `docs/` is an OKF bundle declared in `docs/index.md` frontmatter —
  `docs/features/`, `docs/specs/`, `docs/adrs/`, `docs/wayfinder/`. Go there for
  depth rather than re-deriving it from source.

## Efficient discovery

- Batch independent read-only questions when no result can change the next query.
  Run unrelated `rg`, targeted file reads, and Git inspections in one tool round
  instead of waiting for each result before issuing the next.
- Before the first `Edit` of an existing file in a session — or the first `Write`
  that overwrites one — read that target with the `Read` tool; inherited context
  and shell output do not satisfy either tool's read-before-write precondition.
  Re-read only if an edit, hook, formatter, generator, external process, or
  another agent may have changed the file since. These preconditions are
  repository-wide rather than task-command specific: the same avoidable tool
  failures recur in ordinary and god-mode sessions.
- Pass `Read`'s `offset` and `limit` as integers, never strings. `pages` is a
  string page range (`"1-5"`) and stays a string. Prefer a targeted numeric slice
  when the whole file is unnecessary.
- Apart from that one read-before-write, do not reread an unchanged file that is
  already in the current context. After an edit or external change, inspect only
  the affected section or use a targeted line range unless the whole file is
  genuinely needed again.
- Prefer `rg` and `rg --files` over recursive `grep`, `find`, or multi-directory
  `ls` probes. When no match is an acceptable discovery result, make that explicit
  for that read-only search (`rg ... || true`). Confirm an optional path exists
  before listing a directory or reading, `sed`-ing, or otherwise transforming a
  file, so an absent path does not turn useful discovery into a failed tool result.
- When a question needs a fan-out across many files or directories, hand it to one
  search agent and keep the conclusion instead of issuing the reads serially. Name
  the target files up front when they are already known.

## Shell command forms

- Address files by absolute path, or `git -C <absolute path>`, rather than `cd`-ing
  to a relative subdirectory — the working directory is often a worktree, not the
  main checkout. When a directory must be entered, enter it by absolute path.
- The shell is zsh, where an unmatched unquoted glob aborts the whole command
  (`no matches found`). Quote every pattern the invoked program should expand, and
  prefer `rg -g '<pattern>'` / `rg --files -g '<pattern>'`; `grep --include=*.ts`
  fails here, `rg -g '*.ts'` is the working form.
- Do not read `@{u}` on a branch that may never have been pushed. Push with `-u`
  first, or tolerate the missing upstream explicitly.

## Environment-specific failures

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

- Record how each task worktree was created and remove it through the same
  mechanism. A worktree created by `git worktree add` or a repository helper is not
  owned by a session worktree tool merely because the session later entered it.
- Before removal, inspect `git worktree list --porcelain`, locked state, uncommitted
  changes, and unpushed commits. Run cleanup from outside the target worktree.
- If a tool reports that the session does not own a worktree, do not retry that
  tool. Reconfirm the safety checks, then use the repository helper or
  `git worktree remove <exact-path>` that matches how the worktree was created.

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
