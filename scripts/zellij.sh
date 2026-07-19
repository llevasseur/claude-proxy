#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_NAME="claude-proxy-$$"

cleanup() {
  zellij kill-session "${SESSION_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

cd "${REPO_ROOT}"
unset ZELLIJ ZELLIJ_SESSION_NAME
zellij --new-session-with-layout .zellij/claude-proxy.kdl options \
  --session-name "${SESSION_NAME}" \
  --on-force-close quit
