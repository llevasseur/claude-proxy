# monorepo-fusion-23 — Retire the stale per-stack AGENTS.md files and fix what ticket 14 left dangling

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-23-retire-the-stale-stack-agents-files`
**Status:** active

## Why this ticket exists

Ticket 14 merged the three `AGENTS.md` files into one at the root, and then could not remove
the sources: `git rm` of `stacks/codex/AGENTS.md` and `stacks/ox-alpha/AGENTS.md` was
**refused twice by the permission classifier**. The runner stopped rather than emptying the
files to achieve the same thing by another route, which was the right call — but both remain,
now stale against the merged root, and a stale instruction file is worse than none because a
future agent reads it as current.

Ticket 14 also widened its lane slightly, disclosed it, and left two consequences it could
not reach.

## Criteria

1. **Before deleting anything, confirm the root `AGENTS.md` actually absorbed what those two
   files say.** This is the whole risk: they are the sibling repositories' own instructions,
   and anything in them that did not make it into the root is lost with them. Diff the
   content rather than assuming ticket 14's merge was complete, and **report what you
   checked**. If something is missing, port it first and say so.
2. **Then remove `stacks/codex/AGENTS.md` and `stacks/ox-alpha/AGENTS.md`.** If `git rm` is
   refused again, **stop and report it** — do not empty the files, truncate them, or
   otherwise achieve the deletion by another route. That is what the previous runner refused
   to do and it was correct: a refused operation reached by a different shape is still the
   refused operation.
3. **Fix `stacks/ox-alpha/README.md:29`.** It points at `.zellij/ox-alpha-proxy.kdl` relative
   to the stack, which ticket 14 moved to the repository root. The fix is
   `../../.zellij/ox-alpha-proxy.kdl`. Check codex's README for the same dangling link.
4. **Fix `scripts/bootstrap-worktree.sh`'s stale symlink sources.** It still links
   `apps/admin/.env` and `proxy/.env`, neither of which exists after the relocation — and
   `link_from_main` **skips a missing source silently**, so every new worktree has been
   quietly missing those links. The correct paths are under `stacks/claude/`.
   - **Do not touch the `logs` symlink line.** Ticket 09 owns it and is blocked on the
     operator; changing it here would collide with that ticket and could leave a worktree
     with no logs link at all.

## Constraints

- Own `stacks/codex/AGENTS.md`, `stacks/ox-alpha/AGENTS.md`, the two stack READMEs, and the
  `.env` lines of `scripts/bootstrap-worktree.sh`.
- **Do not touch the root `AGENTS.md`** except to port something criterion 1 finds missing.
- **Zero behaviour change.**

## Done when

Criterion 1's check is reported explicitly, both stale files are gone (or the refusal is
surfaced), no README link dangles, the bootstrap script's `.env` sources exist, and
`gh pr checks` is green.
