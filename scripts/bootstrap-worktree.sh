#!/usr/bin/env bash
#
# Fill in what `git worktree add` leaves out — it materializes only tracked files,
# so a fresh worktree has no `node_modules/`, no `.env`, no `logs/` and no
# `.claude/skills/`. Symlinks env and logs from the main checkout, rebuilds the
# project-skill surface, then installs. `/task` runs this on the worktrees it
# creates.
#
# The main checkout comes from `git rev-parse --git-common-dir` — the shared `.git`
# whichever worktree asks — so no path is hardcoded and no branch or base is
# assumed. Nothing is generated: `@claude-proxy/core` is consumed as TypeScript
# source, so install is the whole build.
#
# Usage: bash scripts/bootstrap-worktree.sh   (from anywhere inside the worktree)

set -euo pipefail

WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON_DIR="$(cd "${WORKTREE_ROOT}" && cd "$(git rev-parse --git-common-dir)" && pwd)"
MAIN_CHECKOUT="$(dirname "${GIT_COMMON_DIR}")"

cd "${WORKTREE_ROOT}"

if [ "${MAIN_CHECKOUT}" = "${WORKTREE_ROOT}" ]; then
  echo "run this from a linked worktree, not the main checkout (${MAIN_CHECKOUT})" >&2
  exit 1
fi

# Link one path, relative to both roots. Missing upstream is skipped; a path the
# worktree already has wins.
link_from_main() {
  local rel="$1"
  local src="${MAIN_CHECKOUT}/${rel}"
  local dst="${WORKTREE_ROOT}/${rel}"

  if [ ! -e "${src}" ]; then
    echo "  skip    ${rel} (not in main checkout)"
    return 0
  fi
  if [ -e "${dst}" ] || [ -L "${dst}" ]; then
    echo "  keep    ${rel} (already present)"
    return 0
  fi

  mkdir -p "$(dirname "${dst}")"
  ln -s "${src}" "${dst}"
  echo "  link    ${rel} -> ${src}"
}

echo "bootstrapping $(basename "${WORKTREE_ROOT}") from ${MAIN_CHECKOUT}"

# Vite loads `apps/admin/.env`; `proxy/.env` records the device's port and no code
# path reads it. Tracked `.env.example` files arrive with the worktree.
echo "env:"
link_from_main "apps/admin/.env"
link_from_main "proxy/.env"

# `resolveLogDir()` (server/src/logs.ts) defaults to `<repo>/logs`, so an unlinked
# worktree serves an empty dashboard and fails its health check. Linking keeps that
# default correct for the server, the daily summary and `/revive`'s store at once.
echo "logs:"
link_from_main "logs"

# The skills arrive with the worktree under `.agents/skills/`; `.claude/skills/`,
# where Claude Code finds them, is gitignored and does not.
echo "skills:"
bash "${WORKTREE_ROOT}/scripts/link-project-skills.sh"

# `.git-blame-ignore-revs` is committed but inert: `blame.ignoreRevsFile` is a
# config key, and git config cannot be committed. Without this line `git blame`
# still lands on the commit that reformatted all 96 of ox's files, for every one
# of them. The path stays relative because linked worktrees share one config with
# the main checkout, so each tree resolves the file in its own root — and setting
# it from here configures that main checkout as well.
echo "blame:"
git config blame.ignoreRevsFile .git-blame-ignore-revs
echo "  set     blame.ignoreRevsFile -> .git-blame-ignore-revs"

# Frozen: the lockfile arrived with the branch, so a failure here is real drift.
echo "install:"
pnpm install --frozen-lockfile

echo "ready: ${WORKTREE_ROOT}"
