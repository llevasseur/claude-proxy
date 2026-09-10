#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_NAME="net-server-$$"

cleanup() {
  zellij kill-session "${SESSION_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

cd "${REPO_ROOT}"

# No .env is required here: with nothing set, net-server resolves its default
# port 8531 (which collides with nothing) and anchors its database at
# stacks/net/data/net.sqlite per ADR 0054.

# A nested session would attach to the outer one instead of building this layout.
unset ZELLIJ ZELLIJ_SESSION_NAME
zellij --new-session-with-layout .zellij/net-server.kdl options \
  --session-name "${SESSION_NAME}" \
  --on-force-close quit
