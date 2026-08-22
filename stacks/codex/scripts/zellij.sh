#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_NAME="codex-proxy-$$"

cleanup() {
  zellij kill-session "${SESSION_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

cd "${REPO_ROOT}"

# No pane reports a missing `.env` — it falls back to built-in defaults and talks
# to the wrong port. Warn before zellij takes over the screen; the panes do run
# without one.
env_found=''
for candidate in .env proxy/.env server/.env apps/admin/.env; do
  if [ -f "${REPO_ROOT}/${candidate}" ]; then
    env_found="${candidate}"
    break
  fi
done

if [ -z "${env_found}" ]; then
  echo "no .env found (looked for .env, proxy/.env, server/.env, apps/admin/.env)." >&2
  echo "the panes will use their built-in defaults. proxy and server both load the" >&2
  echo "repository-root .env; admin reads apps/admin/.env." >&2
  if [ -t 0 ]; then
    printf 'Press Enter to launch anyway, or Ctrl-C to fix it first: ' >&2
    read -r _ || true
  fi
fi

unset ZELLIJ ZELLIJ_SESSION_NAME
zellij --new-session-with-layout .zellij/codex-proxy.kdl options \
  --session-name "${SESSION_NAME}" \
  --on-force-close quit
