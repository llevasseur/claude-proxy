# monorepo-fusion-09 — Migrate the three corpora to their stack roots

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-09-migrate-corpora`
**Status:** active

## Goal

Move three untracked, gitignored data directories to the stack roots their resolvers now
point at, and prove the move by measurement — because no gate in this campaign can see
it. **Read ADR 0054 in full before starting.**

## Why this ticket exists

Relocation moved the code and left the data. `import.meta.dirname/../..` and
`path.join(HERE, '..', 'logs')` both mean "my stack's root", and after relocation that
root is `stacks/<name>/`. So each stack silently begins a **new empty corpus** while the
accumulated one sits at the old path. Nothing fails. Tests use temp directories,
typecheck cannot see a path constant, and `logs/` is gitignored so `git mv` cannot move
it. Under the campaign's capture decision, the corpus is the product.

## Criteria

1. **Record the before state**, per stack: file count and `du -sb` byte count of the
   existing corpus.
2. **Move each corpus** to `stacks/<name>/logs/`. Plain `mv`, once, on this device. Do
   not merge them — one shared `logs/` is foreclosed by the ratified
   one-database-and-one-controller-per-proxy decision, since three stacks' audit files
   in one directory is one shared writer surface.
3. **Record the after state** and **assert both numbers equal the before state.** This
   ticket's done-condition is that measurement, not a green `verify`.
4. **Repoint the worktree bootstrap symlinks.** claude's `logs` is a **symlink** in
   worktrees — which is why `.gitignore` carries `logs` with no trailing slash and
   `scripts/bootstrap-worktree.sh` links it from the main checkout. Point the script's
   targets at `stacks/<name>/logs`.
   - **Moving a symlink and calling it a corpus migration is how this ticket silently
     fails.** Verify you moved the real directory: check that the destination is a
     directory and not a link, and that its byte count is non-trivial.
5. **Run a per-stack ingest smoke test**: start each server, confirm it reads from the
   new path and returns rows that predate the migration. A server reading an empty
   corpus starts cleanly and looks identical to a working one — the assertion must be
   about *rows returned*, not about clean startup.
6. **Confirm `logs` stays in `.gitignore` without a trailing slash** and that the new
   `stacks/*/logs/` paths are ignored too.

## Constraints

- **Change no path-resolution code.** The resolvers are already correct (ADR 0054). If a
  resolver looks wrong, re-read the ADR before editing it.
- This is not revertible by a commit. Do not start it without the before-state numbers
  recorded.

## Done when

The PR body carries the before/after file and byte counts per stack, asserted equal; the
three ingest smoke tests return pre-migration rows; and the bootstrap script's symlinks
resolve to the new locations.
