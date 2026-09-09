#!/usr/bin/env bash
#
# Fill in what `git worktree add` leaves out. It materializes only tracked files, so a
# fresh worktree has no `node_modules/`, no `.env`, no `logs/` and no `.claude/skills/`.
# This script symlinks env and logs from the main checkout, rebuilds the project-skill
# links, then installs. `/task` runs it on the worktrees it creates.
#
# `git rev-parse --git-common-dir` finds the main checkout, since that is the shared
# `.git` whichever worktree asks. No path is hardcoded and no branch or base is assumed.
# Nothing is generated: every core is consumed as TypeScript source, so install is the
# whole build.
#
# Usage: bash scripts/bootstrap-worktree.sh            (from anywhere inside the worktree)
#        bash scripts/bootstrap-worktree.sh --print-verify-contract

set -euo pipefail

# The contract, before anything else. `/verify` asks what this repository boots and where
# to look, and it asks from wherever it happens to be standing, often the main checkout
# with no worktree in play at all. Answering ahead of the guard below is what keeps that
# question separable from bootstrapping. The flag installs nothing, links nothing, and
# writes nothing.
#
# `boot` brings up claude's stack alone, server first and admin behind it, which is why
# one health URL suffices: :5173 answering means :8788 already did. `routes` therefore
# names claude's paths alone, so a diff confined to a sibling stack, or to a proxy this
# does not launch, matches nothing here and lets a verification round skip itself. There
# is no `login`, because the server binds 127.0.0.1 and the dashboard has no auth.
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

# Link one path into the worktree. The first argument is where the link goes and the
# first place to look for a source. Any further arguments are older locations to fall
# back to. A missing source is skipped, and a path the worktree already has wins.
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

# Vite loads admin's `.env`. The server and the concepts service both start with
# `--env-file-if-exists=.env`, so an unlinked worktree runs them on defaults rather than
# failing, which is the quiet kind of wrong. proxy's records the device's port and no
# code path reads it. Tracked `.env.example` files arrive with the worktree.
#
# Each entry carries its pre-fusion path as a fallback, and that is not redundancy. These
# files are gitignored, and updating a checkout past the relocation does not move an
# ignored file. A device that predates fusion still holds them at `apps/admin/`, `proxy/`
# and `server/`, so naming only the new path links nothing while reporting `skip`. Drop
# the second argument once every device has moved its env files.
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

# The skills arrive with the worktree under `.agents/skills/`. `.claude/skills/`, where
# Claude Code finds them, is gitignored and does not.
echo "skills:"
bash "${WORKTREE_ROOT}/scripts/link-project-skills.sh"

# `.git-blame-ignore-revs` is committed but inert. `blame.ignoreRevsFile` is a config
# key, so `git blame` still lands on the reformat commit until this runs. The path stays
# relative because linked worktrees share one config with the main checkout, so setting
# it here configures that too.
echo "blame:"
git config blame.ignoreRevsFile .git-blame-ignore-revs
echo "  set     blame.ignoreRevsFile -> .git-blame-ignore-revs"

# Frozen: the lockfile arrived with the branch, so a failure here is real drift.
echo "install:"
pnpm install --frozen-lockfile

echo "ready: ${WORKTREE_ROOT}"
