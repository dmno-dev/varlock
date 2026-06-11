#!/usr/bin/env bash
set -euo pipefail

# Claude Code PreToolUse hook (Bash tool).
#
# Blocks `git push` while the current branch still has an auto-generated
# worktree name (e.g. claude/dreamy-jones-a79c22). Exit code 2 blocks the
# tool call and feeds stderr back to Claude, which then renames the branch
# per AGENTS.md "Branches & pull requests" and retries.

input="$(cat)"
command="$(jq -r '.tool_input.command // empty' <<<"$input")"

[[ "$command" == *"git push"* ]] || exit 0

cwd="$(jq -r '.cwd // empty' <<<"$input")"
branch="$(git -C "${cwd:-.}" branch --show-current 2>/dev/null || true)"

# Auto-generated names look like <word>-<word>-<hex>, optionally claude/-prefixed.
if [[ "$branch" =~ ^(claude/)?[a-z]+-[a-z]+-[0-9a-f]{4,8}$ ]]; then
  echo "Blocked: current branch '$branch' is an auto-generated worktree name." >&2
  echo "Rename it to describe the change first (git branch -m claude/<meaningful-name>), then push. See AGENTS.md 'Branches & pull requests'." >&2
  exit 2
fi
exit 0
