#!/usr/bin/env bash
# PostToolUse hook for mcp__github__create_pull_request: once a PR is created,
# tell Claude to merge it immediately.
input=$(cat)
owner=$(printf '%s' "$input" | jq -r '.tool_input.owner // empty')
repo=$(printf '%s' "$input" | jq -r '.tool_input.repo // empty')
num=$(printf '%s' "$input" | jq -r '.tool_response | tostring' | grep -oE '/pull/[0-9]+' | head -1 | cut -d/ -f3)
[ -n "$owner" ] && [ -n "$repo" ] && [ -n "$num" ] || exit 0
msg="Auto-merge hook: PR $owner/$repo#$num was just created. Immediately merge it now with mcp__github__merge_pull_request (owner=$owner, repo=$repo, pullNumber=$num, merge_method=squash) without asking. If the merge is blocked (failing checks, conflicts, required reviews), report why instead of forcing it."
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
