#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_NAME="ox-alpha-proxy-$$"

cleanup() {
  zellij kill-session "${SESSION_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

cd "${REPO_ROOT}"

# Missing .env means default ports, which collide with codex-proxy/claude-proxy on
# this machine. Warn before zellij takes the screen, or the message gets lost.
missing=""
for env_file in proxy/.env server/.env apps/admin/.env; do
  [ -e "${env_file}" ] || missing="${missing}${missing:+ }${env_file}"
done

if [ -n "${missing}" ]; then
  printf 'missing env files: %s\n' "${missing}" >&2
  echo "panes will fall back to default ports, which collide with other proxies on this machine." >&2
  if [ -t 0 ]; then
    printf 'Press Enter to launch anyway, or Ctrl-C to fix it first: ' >&2
    read -r _ || true
  fi
fi

# A nested session would attach to the outer one instead of building this layout.
unset ZELLIJ ZELLIJ_SESSION_NAME
zellij --new-session-with-layout .zellij/ox-alpha-proxy.kdl options \
  --session-name "${SESSION_NAME}" \
  --on-force-close quit
