#!/usr/bin/env bash
set -euo pipefail

# Claude Code SessionStart hook.
#
# Makes sure a freshly-created git worktree has installed deps + built libs
# before the session uses it (fresh worktrees have no node_modules, which breaks
# typecheck/build/tests).
#
# We deliberately do NOT do this from a WorktreeCreate hook: WorktreeCreate fully
# REPLACES Claude's native worktree creation, which would discard the base-branch
# picker, the `origin/HEAD` default base (latest origin default branch), and
# `.worktreeinclude` env-file copying. Letting native creation run and doing
# setup here keeps all of that — the worktree branches off latest origin/main and
# the picker is honored.
#
# This fires on every session start, so it no-ops fast when deps already exist
# (the common case: the main checkout and any already-warmed worktree).
#
# NOTE: for new worktrees this only takes effect once it's committed to the
# branch they branch from (origin/main) — a SessionStart hook reads the
# worktree's own checked-out .claude/settings.json.
#
# stdin payload: session_id, transcript_path, cwd, hook_event_name, source.
# Requires: jq, bun.

input="$(cat)"

cwd="$(jq -r '.cwd // empty' <<<"$input")"
cwd="${cwd:-$PWD}"
cd "$cwd"

# Already set up (main checkout or a warm worktree) — nothing to do. Keep normal
# session starts instant.
if [ -d node_modules ]; then
  exit 0
fi

# Only act inside a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

echo "Fresh worktree detected — installing deps + building libs..." 1>&2

# Share the main repo's turbo cache so build:libs is mostly cache hits instead of
# a cold build. The main repo is the parent of the shared git common dir.
common_dir="$(git rev-parse --git-common-dir)"
case "$common_dir" in
  /*) ;;
  *) common_dir="$(cd "$common_dir" && pwd)" ;;
esac
main_repo="$(dirname "$common_dir")"

mkdir -p "$main_repo/.turbo/cache" .turbo
ln -sfn "$main_repo/.turbo/cache" .turbo/cache

bun install 1>&2
bun run build:libs 1>&2

echo "Worktree setup complete." 1>&2
