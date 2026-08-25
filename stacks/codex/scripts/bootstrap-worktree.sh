#!/usr/bin/env bash
#
# Symlinks the main checkout's `.env` files and `logs/` into a fresh worktree,
# then installs. `git worktree add` materializes tracked files only, so a worktree
# has none of them. The main checkout is resolved from `git rev-parse
# --git-common-dir`, so no path is hardcoded and no base branch is assumed.
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

# Link one path, relative to both roots. A missing source is skipped; a path the
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

# Every `.env` this repo can read: the root file, then the per-package files
# `pnpm --filter` runs land in. Only some exist on a given device.
echo "env:"
link_from_main ".env"
link_from_main "proxy/.env"
link_from_main "server/.env"
link_from_main "apps/admin/.env"

# `AUDIT_DIR` and `DATABASE_PATH` both default under `<repo>/logs`; an unlinked
# worktree ingests nothing and serves an empty Overview.
echo "logs:"
link_from_main "logs"

echo "install:"
pnpm install --frozen-lockfile

echo "ready: ${WORKTREE_ROOT}"
