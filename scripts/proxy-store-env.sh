#!/usr/bin/env bash
#
# Resolve and export CLAUDE_PROXY_STORE — the directory holding this checkout's
# per-session transcripts — so `/revive --source proxy` never has to guess a path.
#
# The store is `<LOG_DIR>/sessions` (`sessionsDir` in proxy/session.mjs), where
# LOG_DIR defaults to `<repo>/logs`. This script derives it from its own location,
# so it stays correct after a move, a rename, or a second clone.
#
# Nothing here runs on its own: no install hook, no dev-server hook. `pnpm
# setup:env` (`--setup`) is the only entry point that changes anything, and all it
# changes is inside the repo — it creates the store directory and prints the two
# device snippets for you to add. Every other mode is read-only.
#
# Source it to configure a shell (this is the device hookup — one line in ~/.zshrc
# keeps every future shell, and every `claude` launched from one, configured):
#
#   source /path/to/claude-proxy/scripts/proxy-store-env.sh
#
# Or run it:
#
#   pnpm setup:env                          # create the store, print the hookup
#   pnpm check:env                          # report, non-zero when unconfigured
#   scripts/proxy-store-env.sh              # print export lines (for `eval`)
#   eval "$(scripts/proxy-store-env.sh)"    # configure the current shell

# No `set -e`: this file gets sourced into interactive shells, where a failing
# command must not kill the shell.

# Locate the repo from this file, whether sourced or executed.
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _cpe_self="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  _cpe_self="${(%):-%x}"
else
  _cpe_self="$0"
fi
_cpe_root="$(cd "$(dirname "$_cpe_self")/.." && pwd)"

_cpe_store="${LOG_DIR:-$_cpe_root/logs}/sessions"

# CLAUDE_PROXY_ARCHIVE is optional — it only means anything once whole days have
# been relocated out of the live logs dir. Adopt the conventional root only when it
# actually holds a relocated `sessions/` dir; otherwise leave it unset.
_cpe_archive="${CLAUDE_PROXY_ARCHIVE:-}"
if [ -z "$_cpe_archive" ]; then
  _cpe_archive_root="$HOME/Documents/logs/claude"
  if [ -d "$_cpe_archive_root" ] && [ -n "$(find "$_cpe_archive_root" -maxdepth 3 -type d -name sessions -print -quit 2>/dev/null)" ]; then
    _cpe_archive="$_cpe_archive_root"
  fi
fi

# The caller's value, captured before the export below — what --check compares
# against to tell a configured shell from an unconfigured one.
_cpe_inherited="${CLAUDE_PROXY_STORE:-}"

# Resolving touches nothing on disk; only `--setup` creates the directory.
export CLAUDE_PROXY_STORE="$_cpe_store"
[ -z "$_cpe_archive" ] || export CLAUDE_PROXY_ARCHIVE="$_cpe_archive"

_cpe_exports() {
  echo "export CLAUDE_PROXY_STORE=\"$_cpe_store\""
  [ -z "$_cpe_archive" ] || echo "export CLAUDE_PROXY_ARCHIVE=\"$_cpe_archive\""
}

_cpe_setup() {
  # The one mutating mode — /revive fails fast on a missing store path.
  if ! mkdir -p "$_cpe_store" 2>/dev/null; then
    echo "cannot create the store directory: $_cpe_store" >&2
    return 1
  fi
  echo "store directory ready: $_cpe_store"
  if [ -z "$(find "$_cpe_store" -maxdepth 1 -name '*.md' -print -quit 2>/dev/null)" ]; then
    # Configured but empty still looks broken to /revive.
    echo "note: no transcripts yet — restart the proxy if it has been running since before session logging landed"
  fi
  echo
  _cpe_hookup
}

_cpe_hookup() {
  cat <<EOF
Add to ~/.zshrc (or ~/.bashrc) so every new shell — and every \`claude\` launched
from one — resolves the store, including after this checkout moves:

  source $_cpe_root/scripts/proxy-store-env.sh

Sessions that don't inherit a login shell (the Claude Code desktop app) read env
from ~/.claude/settings.json instead. To cover those, add to its "env" block:

  "CLAUDE_PROXY_STORE": "$_cpe_store"
EOF
  [ -z "$_cpe_archive" ] || echo "  \"CLAUDE_PROXY_ARCHIVE\": \"$_cpe_archive\""
}

_cpe_check() {
  _cpe_status=0
  echo "CLAUDE_PROXY_STORE    $_cpe_store"
  if [ -z "$_cpe_archive" ]; then
    echo "CLAUDE_PROXY_ARCHIVE  (unset — archive lookups skipped)"
  else
    echo "CLAUDE_PROXY_ARCHIVE  $_cpe_archive"
  fi
  if [ ! -d "$_cpe_store" ]; then
    echo "store directory missing: $_cpe_store (run: pnpm setup:env)"
    _cpe_status=1
  elif [ -z "$(find "$_cpe_store" -maxdepth 1 -name '*.md' -print -quit 2>/dev/null)" ]; then
    # Configured but empty still looks broken to /revive.
    echo "note: no transcripts yet — restart the proxy if it has been running since before session logging landed"
  fi
  # The resolved path can be correct while the shell itself is unconfigured, which
  # is the failure /revive actually sees.
  if [ "$_cpe_inherited" != "$_cpe_store" ]; then
    echo "this shell: CLAUDE_PROXY_STORE=${_cpe_inherited:-unset} — add the rc line below"
    echo
    _cpe_hookup
    _cpe_status=1
  fi
  return "$_cpe_status"
}

# Sourced: the exports above are the whole job — stay silent, leave no helpers
# behind. Executed: act on the flag.
_cpe_sourced=0
if [ -n "${ZSH_VERSION:-}" ]; then
  case "${ZSH_EVAL_CONTEXT:-}" in *:file*) _cpe_sourced=1 ;; esac
elif [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
  _cpe_sourced=1
fi

if [ "$_cpe_sourced" = "1" ]; then
  unset -f _cpe_setup _cpe_exports _cpe_hookup _cpe_check 2>/dev/null
  unset _cpe_self _cpe_root _cpe_store _cpe_archive _cpe_archive_root _cpe_inherited _cpe_sourced
else
  case "${1:-}" in
    --setup) _cpe_setup ;;
    --check) _cpe_check ;;
    --hookup) _cpe_hookup ;;
    "") _cpe_exports ;;
    -h | --help) sed -n '2,28p' "$_cpe_self" | sed 's|^# \{0,1\}||' ;;
    *)
      echo "proxy-store-env: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
fi
