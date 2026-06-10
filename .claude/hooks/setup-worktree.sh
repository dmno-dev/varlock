#!/usr/bin/env bash
set -euo pipefail

# Claude Code WorktreeCreate hook.
#
# WorktreeCreate REPLACES Claude's default `git worktree add`, so this script is
# fully responsible for the whole creation flow:
#   1. create the git worktree
#   2. install deps + build libs (the reason this hook exists — fresh worktrees
#      have no node_modules, which breaks typecheck/build/tests)
#   3. print the worktree path to stdout — and NOTHING else, or creation fails
#
# Everything except the final path is redirected to stderr to keep stdout clean.
# Mirrors .codex/scripts/setup-worktree.sh for parity with the Codex setup.
#
# Requires: jq, bun (both expected on a varlock dev machine).

input="$(cat)"
worktree_path="$(jq -r '.worktree_path' <<<"$input")"
worktree_name="$(jq -r '.worktree_name' <<<"$input")"
base_commit="$(jq -r '.base_commit' <<<"$input")"

# Create the worktree on a new branch, mirroring Claude's `claude/<name>` convention.
# Fall back to a detached worktree if the branch already exists.
git worktree add -b "claude/$worktree_name" "$worktree_path" "$base_commit" 1>&2 \
  || git worktree add --detach "$worktree_path" "$base_commit" 1>&2

# Project setup inside the new worktree (same as .codex/scripts/setup-worktree.sh).
(
  cd "$worktree_path"
  bun install
  bun run build:libs
) 1>&2

# Hand the worktree path back to Claude Code.
printf '%s\n' "$worktree_path"
