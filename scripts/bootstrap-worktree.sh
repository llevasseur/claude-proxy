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
# assumed. Nothing is generated: every core is consumed as TypeScript source, so
# install is the whole build.
#
# Usage: bash scripts/bootstrap-worktree.sh            (from anywhere inside the worktree)
#        bash scripts/bootstrap-worktree.sh --print-verify-contract

set -euo pipefail

# The contract, ahead of the guard below: `/verify` asks it from wherever it stands,
# often the main checkout with no worktree in play. Installs nothing, links nothing.
# `boot` brings up claude's stack alone, server first and admin behind it, so :5173
# answering means :8788 already did. `routes` names claude's paths only, so a diff
# confined to a sibling stack matches nothing and the round skips itself. No `login`:
# the server binds 127.0.0.1 and the dashboard has no auth.
if [ "${1:-}" = "--print-verify-contract" ]; then
  cat <<'JSON'
{
  "boot": "bash scripts/dev-boot.sh",
  "health": "http://127.0.0.1:5173/",
  "routes": {
    "stacks/claude/admin/src/routes/overview.tsx": "/",
    "stacks/claude/admin/src/routes/session*.tsx": "/sessions",
    "stacks/claude/admin/src/routes/trend*.tsx": "/trends",
    "stacks/claude/admin/src/routes/advice.tsx": "/advice",
    "stacks/claude/admin/src/routes/idea*.tsx": "/ideas",
    "stacks/claude/admin/src/routes/internet.tsx": "/internet",
    "stacks/claude/admin/src/**": "/",
    "stacks/claude/server/src/**": "/",
    "stacks/claude/core/src/**": "/"
  }
}
JSON
  exit 0
fi

WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON_DIR="$(cd "${WORKTREE_ROOT}" && cd "$(git rev-parse --git-common-dir)" && pwd)"
MAIN_CHECKOUT="$(dirname "${GIT_COMMON_DIR}")"

cd "${WORKTREE_ROOT}"

if [ "${MAIN_CHECKOUT}" = "${WORKTREE_ROOT}" ]; then
  echo "run this from a linked worktree, not the main checkout (${MAIN_CHECKOUT})" >&2
  exit 1
fi

# Link one path into the worktree. The first argument is the destination and the first
# source to try; any further arguments are older locations to fall back to. Missing
# upstream is skipped; a path the worktree already has wins.
link_from_main() {
  local rel="$1"
  shift
  local dst="${WORKTREE_ROOT}/${rel}"
  local candidate src=""

  for candidate in "${rel}" "$@"; do
    if [ -e "${MAIN_CHECKOUT}/${candidate}" ]; then
      src="${MAIN_CHECKOUT}/${candidate}"
      break
    fi
  done

  if [ -z "${src}" ]; then
    echo "  skip    ${rel} (not in main checkout)"
    return 0
  fi
  if [ -e "${dst}" ] || [ -L "${dst}" ]; then
    echo "  keep    ${rel} (already present)"
    return 0
  fi

  mkdir -p "$(dirname "${dst}")"
  ln -s "${src}" "${dst}"
  if [ "${src}" = "${MAIN_CHECKOUT}/${rel}" ]; then
    echo "  link    ${rel} -> ${src}"
  else
    echo "  link    ${rel} -> ${src} (pre-fusion path)"
  fi
}

echo "bootstrapping $(basename "${WORKTREE_ROOT}") from ${MAIN_CHECKOUT}"

# The server and the concepts service start with `--env-file-if-exists=.env`, so an
# unlinked worktree runs them on defaults rather than failing. Tracked `.env.example`
# files arrive with the worktree.
#
# The second argument is each file's pre-fusion path. These are gitignored, and updating
# a checkout past the relocation does not move an ignored file, so a device that predates
# fusion still holds them there. Drop the fallbacks once every device has moved them.
echo "env:"
link_from_main "stacks/claude/admin/.env" "apps/admin/.env"
link_from_main "stacks/claude/proxy/.env" "proxy/.env"
link_from_main "stacks/claude/server/.env" "server/.env"
link_from_main "services/concepts/.env"

# `resolveLogDir()` (stacks/claude/server/src/logs.ts) defaults to `<repo>/logs`, so an
# unlinked worktree serves an empty dashboard and fails its health check. Linking keeps
# that default correct for the server, the daily summary and `/revive`'s store at once.
echo "logs:"
link_from_main "logs"

# The skills arrive with the worktree under `.agents/skills/`; `.claude/skills/`,
# where Claude Code finds them, is gitignored and does not.
echo "skills:"
bash "${WORKTREE_ROOT}/scripts/link-project-skills.sh"

# `.git-blame-ignore-revs` is committed but inert — `blame.ignoreRevsFile` is a
# config key, so `git blame` still lands on the reformat commit until this runs.
# Path stays relative: linked worktrees share one config with the main checkout,
# so setting it here configures that too.
echo "blame:"
git config blame.ignoreRevsFile .git-blame-ignore-revs
echo "  set     blame.ignoreRevsFile -> .git-blame-ignore-revs"

# Frozen: the lockfile arrived with the branch, so a failure here is real drift.
echo "install:"
pnpm install --frozen-lockfile

echo "ready: ${WORKTREE_ROOT}"
