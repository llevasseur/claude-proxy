#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_NAME="claude-proxy-$$"

cleanup() {
  zellij kill-session "${SESSION_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

cd "${REPO_ROOT}"

# The panes inherit this shell's env, and no pane reports an unconfigured
# CLAUDE_PROXY_STORE. Check before zellij takes over the screen; warn only, since
# the proxy and dashboard panes work without the store.
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
