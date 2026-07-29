# Repository Agent Instructions

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
  for that read-only search (`rg ... || true`). Check an optional directory exists
  before listing it so an absent path does not turn useful discovery into a failed
  tool result.

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
  weakened. Inspect the refused command first; when the intended operation is
  safe, retry only the smallest exact command instead of allowlisting a broader
  Bash pattern or changing permission settings.
