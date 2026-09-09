#!/usr/bin/env bash
#
# Boot claude's dashboard the way a verification run needs it. One foreground command
# brings up both processes and does not return until they exit. `/verify` reads this
# command out of `scripts/bootstrap-worktree.sh --print-verify-contract` and runs it in
# the background, so two rules hold here. It streams both children's output on this
# stdout, because the `listening on ...` lines are how the real bound port is read back.
# And it takes its children down with it.
#
# Order matters. The server comes up first and is polled until `/api/health` answers.
# Only then does Vite start. That ordering is what lets the contract name a single
# health URL, since the admin origin answering implies the API behind it already does.
#
# Usage: bash scripts/dev-boot.sh   (from anywhere inside the checkout)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

# ADR 0050's resolution order, mirrored so the health probe below aims at whichever port
# the server will actually take. `strictPort` pins Vite, so its port is not negotiable
# and reading an override would misreport it.
SERVER_PORT="${CLAUDE_SERVER_PORT:-${PORT:-8788}}"
ADMIN_PORT=5173
SERVER_HEALTH="http://127.0.0.1:${SERVER_PORT}/api/health"
ADMIN_URL="http://127.0.0.1:${ADMIN_PORT}/"

PIDS=()

# pnpm sits between this script and the process that holds the port, so killing the pid
# it reports orphans `tsx` and `vite`. An orphan rooted in a worktree keeps writing to
# the shared `logs/` symlink after the directory is gone. Kill the children first, then
# the wrapper.
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid}" ] || continue
    pkill -P "${pid}" 2>/dev/null || true
    kill "${pid}" 2>/dev/null || true
  done
}

trap cleanup EXIT HUP INT TERM

# Poll rather than sleep a fixed span. A cold `tsx watch` over this corpus is slow enough
# that any constant is either a stall or a flake.
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

# Hold the foreground for as long as either child lives, so the caller's background job
# tracks the app rather than this script's setup.
wait
