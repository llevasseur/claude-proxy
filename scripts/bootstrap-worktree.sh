#!/usr/bin/env bash
#
# Make a linked worktree behave like the main checkout.
#
# `git worktree add` only materializes *tracked* files, so a fresh worktree starts
# without the three things this repo keeps out of git: `node_modules/`, the `.env`
# files, and `logs/` — the sidecar directory every dashboard view reads. This
# script fills those in, and is what `/task` looks for when it sets up a worktree.
#
# The main checkout is found via `git rev-parse --git-common-dir`, which points at
# the *shared* `.git` no matter which linked worktree asks. Nothing here hardcodes
# a path, so the script survives a move, a rename, or a second clone — the same
# resolution `scripts/proxy-store-env.sh` already does for the transcript store.
#
# Env and logs are symlinked, never copied: the main checkout stays the single
# source of truth, so a `.env` edit or a newly written sidecar is visible from
# every worktree at once and nothing drifts. Existing files are left alone, and
# anything missing upstream is skipped with a note rather than invented.
#
# Branch-agnostic by construction: it reads only this worktree's working tree and
# the main checkout, never `main` or any assumed base. There is no code generation
# step because the repo has none — `@claude-proxy/core` is consumed as TypeScript
# source (the server runs it through tsx, Vite excludes it from optimizeDeps), so
# `pnpm install` is genuinely all the build this needs.
#
# Usage: bash scripts/bootstrap-worktree.sh   (from anywhere inside the worktree)

set -euo pipefail

WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON_DIR="$(cd "${WORKTREE_ROOT}" && cd "$(git rev-parse --git-common-dir)" && pwd)"
MAIN_CHECKOUT="$(dirname "${GIT_COMMON_DIR}")"

cd "${WORKTREE_ROOT}"

# Every action below either reads from the main checkout or writes a symlink into
# it — harmless from a linked worktree, meaningless (or destructive) from the main
# checkout itself, which already has the real files.
if [ "${MAIN_CHECKOUT}" = "${WORKTREE_ROOT}" ]; then
  echo "run this from a linked worktree, not the main checkout (${MAIN_CHECKOUT})" >&2
  exit 1
fi

# Link one path from the main checkout, relative to both roots. Missing upstream
# is normal (a device that never configured that env file); an existing path wins,
# so a deliberately divergent worktree file is never clobbered.
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

# Gitignored env. `apps/admin/.env` is loaded by Vite; `proxy/.env` is a record of
# the device's port that no code path reads today, linked so the worktree stays a
# faithful copy. Tracked `.env.example` files arrive with the worktree already.
echo "env:"
link_from_main "apps/admin/.env"
link_from_main "proxy/.env"

# `logs/` is where the proxy writes sidecars and the only thing the server reads:
# `resolveLogDir()` (server/src/logs.ts) defaults to `<repo>/logs`, so without this
# link a worktree's dashboard is empty and its health check fails. Linking rather
# than overriding LOG_DIR keeps that default correct for every entry point at once
# — server, daily summary, and `/revive`'s store — with no env to remember. Writes
# that belong to the logs (`suggestion-status.json`) land beside the transcripts
# they describe, which is where that file is meant to live.
echo "logs:"
link_from_main "logs"

# Install at the worktree root: pnpm links the workspace packages here and shares
# the global store, so this is cheap. Frozen because the lockfile arrived with the
# branch and should match it — a failure here means real lockfile drift, not a
# stale worktree.
echo "install:"
pnpm install --frozen-lockfile

echo "ready: ${WORKTREE_ROOT}"
