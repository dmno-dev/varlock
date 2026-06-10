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
# stdin payload (observed from a real invocation, June 2026): session_id,
# transcript_path, cwd, hook_event_name, name. The docs call the name field
# `worktree_name`, so accept either. There is no path or base-commit field —
# the hook picks the worktree path and base itself.
#
# Requires: jq, bun (both expected on a varlock dev machine).

input="$(cat)"

worktree_name="$(jq -r '.name // .worktree_name // empty' <<<"$input")"
if [ -z "$worktree_name" ]; then
  worktree_name="wt-$(jq -r '.session_id // empty' <<<"$input" | cut -c1-8)"
fi

repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
worktree_path="$repo_root/.claude/worktrees/$worktree_name"

# Create the worktree on a new branch, mirroring Claude's `claude/<name>` convention.
# Fall back to a detached worktree if the branch already exists.
git -C "$repo_root" worktree add -b "claude/$worktree_name" "$worktree_path" HEAD 1>&2 \
  || git -C "$repo_root" worktree add --detach "$worktree_path" HEAD 1>&2

# Project setup inside the new worktree (same as .codex/scripts/setup-worktree.sh).
(
  cd "$worktree_path"
  bun install
  bun run build:libs
) 1>&2

# Hand the worktree path back to Claude Code.
printf '%s\n' "$worktree_path"
