#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_NAME="claude-proxy-$$"

cleanup() {
  zellij kill-session "${SESSION_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

cd "${REPO_ROOT}"

# The panes inherit this shell's env, so an unconfigured CLAUDE_PROXY_STORE breaks
# everything downstream of the transcript store (`/revive --source proxy`, the
# session views) without any pane saying so. Check here, while there is still a
# plain terminal to print to — once zellij takes over the screen the warning is
# gone. Read-only, and a failure only warns: the dashboard and proxy panes work
# fine without the store, so this must not stand between you and them.
if ! env_report="$(bash scripts/proxy-store-env.sh --check 2>&1)"; then
  printf '%s\n\n' "${env_report}" >&2
  echo "environment incomplete — features that read the transcript store stay broken until this is fixed." >&2
  if [ -t 0 ]; then
    printf 'Press Enter to launch anyway, or Ctrl-C to fix it first: ' >&2
    read -r _ || true
  fi
fi

unset ZELLIJ ZELLIJ_SESSION_NAME
zellij --new-session-with-layout .zellij/claude-proxy.kdl options \
  --session-name "${SESSION_NAME}" \
  --on-force-close quit
