#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
common_dir="$(git rev-parse --git-common-dir)"
main_checkout="$(cd "$common_dir/.." && pwd)"

if [[ "$main_checkout" == "$root" ]]; then
  echo "already in the main checkout; nothing to bootstrap" >&2
  exit 0
fi

for env_file in .env proxy/.env server/.env apps/admin/.env; do
  if [[ -e "$main_checkout/$env_file" && ! -e "$root/$env_file" ]]; then
    mkdir -p "$root/$(dirname "$env_file")"
    ln -s "$main_checkout/$env_file" "$root/$env_file"
    echo "symlinked $env_file"
  fi
done

if [[ -e "$main_checkout/logs" && ! -e "$root/logs" ]]; then
  ln -s "$main_checkout/logs" "$root/logs"
  echo "symlinked logs/"
fi

pnpm install --frozen-lockfile
