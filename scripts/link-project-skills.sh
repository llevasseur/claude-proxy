#!/usr/bin/env bash
#
# Surface every project skill tracked under `.agents/skills/` at
# `.claude/skills/<name>`, which is where Claude Code discovers a project's skills.
#
# `.claude/skills/` is gitignored: those entries are a per-checkout *surface*, not
# content. The skills themselves stay tracked under `.agents/skills/`, so this
# rebuilds the surface from whatever the branch already carries — which is what
# makes the skills reachable in a fresh worktree, where `git worktree add`
# materializes the tracked `.agents/skills/` tree and nothing else.
#
# Idempotent: an entry that already exists is left exactly as it is, so a
# hand-placed override survives. Runs from anywhere inside a checkout or worktree.
#
# Usage: bash scripts/link-project-skills.sh
#   also wired into `postinstall` and `scripts/bootstrap-worktree.sh`.

set -euo pipefail

# Derived from this script's own location rather than `git rev-parse`, so it holds
# in a checkout, in a worktree, and in a `postinstall` that git may not reach.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT}/.agents/skills"
DST_DIR="${ROOT}/.claude/skills"

if [ ! -d "${SRC_DIR}" ]; then
  echo "  skip    .claude/skills (no .agents/skills under ${ROOT})"
  exit 0
fi

mkdir -p "${DST_DIR}"

for src in "${SRC_DIR}"/*; do
  [ -d "${src}" ] || continue

  name="$(basename "${src}")"
  dst="${DST_DIR}/${name}"

  if [ -e "${dst}" ] || [ -L "${dst}" ]; then
    echo "  keep    .claude/skills/${name} (already present)"
    continue
  fi

  # Relative, so the link resolves inside whichever checkout it was made in
  # rather than pinning every worktree back to the one it was created from.
  ln -s "../../.agents/skills/${name}" "${dst}"
  echo "  link    .claude/skills/${name} -> ../../.agents/skills/${name}"
done
