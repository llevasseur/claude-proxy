#!/usr/bin/env bash
#
# Boots claude's dashboard as one foreground command: the server first, polled until
# `/api/health` answers, then Vite, holding the foreground until both exit. That
# ordering is what lets the run contract name a single health URL, since :5173 answering
# implies :8788 already did. Both children's output streams on this stdout, so the
# `listening on ...` lines stay readable as the real bound port.
#
# Usage: bash scripts/dev-boot.sh   (from anywhere inside the checkout)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

# ADR 0050's resolution order, so the probe below aims at the port the server will take.
# `strictPort` pins Vite, so reading an override for it would misreport.
SERVER_PORT="${CLAUDE_SERVER_PORT:-${PORT:-8788}}"
ADMIN_PORT=5173
SERVER_HEALTH="http://127.0.0.1:${SERVER_PORT}/api/health"
ADMIN_URL="http://127.0.0.1:${ADMIN_PORT}/"

PIDS=()

# pnpm sits between this script and the process holding the port, so killing the pid it
# reports orphans `tsx` and `vite`, and an orphan rooted in a worktree keeps writing to
# the shared `logs/` symlink after the directory is gone. Children first, wrapper second.
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid}" ] || continue
    pkill -P "${pid}" 2>/dev/null || true
    kill "${pid}" 2>/dev/null || true
  done
}

trap cleanup EXIT HUP INT TERM

# A cold `tsx watch` over this corpus is slow enough that any fixed sleep is either a
# stall or a flake.
wait_for() {
  local url="$1" what="$2" deadline=$((SECONDS + 120))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if curl -sfo /dev/null --max-time 2 "${url}"; then
      echo "[dev-boot] ${what} ready at ${url}"
      return 0
    fi
    sleep 1
  done
  echo "[dev-boot] ${what} did not answer ${url} within 120s" >&2
  return 1
}

echo "[dev-boot] starting server on :${SERVER_PORT}"
pnpm --filter @agent-proxy/claude-server dev &
PIDS+=("$!")
wait_for "${SERVER_HEALTH}" "server"

echo "[dev-boot] starting admin on :${ADMIN_PORT}"
pnpm --filter @agent-proxy/claude-admin dev &
PIDS+=("$!")
wait_for "${ADMIN_URL}" "admin"

echo "[dev-boot] ready: ${ADMIN_URL}"

# Hold the foreground while either child lives, so the caller's background job tracks the
# app rather than this script's setup.
wait
