#!/usr/bin/env bash
set -euo pipefail

# Claude Code PostToolUse hook (matcher: Bash).
#
# Reminds Claude to keep an open PR's description in sync after a `git push`.
#
# The hook runs on *every* Bash call, so we must inspect the actual command
# ourselves and stay silent unless it was really a `git push`. (Hook command
# objects have no per-command `if`/condition field — an `if` key is silently
# ignored, which previously made this fire on every Bash invocation.)

input=$(cat)

# Extract the command that was run. Prefer jq; fall back to a sed extractor.
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
else
  cmd=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')
fi

# Only fire for a real `git push` invocation (start of command or after a
# separator like ; && || |), not for arbitrary commands that mention the words.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|]|&&|[[:space:]])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*push'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"git push ran. If this added commits to an open PR, check that the PR description still matches what changed and update it with gh pr edit if it is now stale."}}'
fi
