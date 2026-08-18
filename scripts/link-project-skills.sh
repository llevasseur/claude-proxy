#!/usr/bin/env bash
#
# Link every project skill tracked under `.agents/skills/` to `.claude/skills/<name>`,
# where Claude Code discovers them. `.claude/skills/` is gitignored, so each checkout
# — a fresh worktree included — rebuilds it here.
#
# Idempotent: an entry that already exists is left exactly as it is.
#
# Usage: bash scripts/link-project-skills.sh
#   also wired into `postinstall` and `scripts/bootstrap-worktree.sh`.

set -euo pipefail

# From the script's own location, not `git rev-parse`: `postinstall` may run where
# git does not reach.
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

  # Relative, so each checkout resolves to its own `.agents/skills/`.
  ln -s "../../.agents/skills/${name}" "${dst}"
  echo "  link    .claude/skills/${name} -> ../../.agents/skills/${name}"
done
