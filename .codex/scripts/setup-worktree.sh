#!/usr/bin/env bash
set -euo pipefail

# Share the main repo's turbo cache so build:libs is mostly cache hits
# instead of a cold build on every new worktree.
main_repo="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
if [ "$main_repo" != "$PWD" ]; then
  mkdir -p "$main_repo/.turbo/cache" .turbo
  ln -sfn "$main_repo/.turbo/cache" .turbo/cache
fi

bun install
bun run build:libs
