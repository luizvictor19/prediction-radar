#!/usr/bin/env bash
#
# PreToolUse hook for Bash: deny a git commit while the branch is main.
#
# The deny list in settings.json can only block or allow a command whole; it
# cannot say "only on main". Until this hook, the deny list blocked every
# `git commit` and `git push` on every branch, which also blocked the work it
# was meant to protect. This hook is the "only on main"; the deny list keeps
# merge, rebase, hard reset and force push.
#
# Copied from chelsea-st-app, where a delivery was once committed straight on
# main and its commits never left it.
#
# Reads the hook input from stdin. Denies by printing a PreToolUse decision;
# in every other case exits 0 with no output, which lets the call through.

set -euo pipefail

input="$(cat)"
command="$(jq -r '.tool_input.command // empty' <<<"$input")"
cwd="$(jq -r '.cwd // empty' <<<"$input")"

# git, optionally with global options (-C path, -c key=value, --no-pager, ...),
# then the commit subcommand. Anchored at the start or after a separator, so a
# chained "git add . && git commit" is caught as well.
commit='(^|[;&|(`{]|\$\()[[:space:]]*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+commit([[:space:]]|$)'

grep -Eq "$commit" <<<"$command" || exit 0

# A `git -C <path> commit` commits in <path>, not in the session's cwd, so the
# branch is read from there when the flag is present.
dir="$(grep -Eo 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' <<<"$command" | head -n1 | awk '{print $3}' || true)"
dir="${dir/#\~/$HOME}"
if [[ -n "$dir" && "$dir" != /* ]]; then
  dir="${cwd:-.}/$dir"
fi

branch="$(git -C "${dir:-${cwd:-.}}" branch --show-current 2>/dev/null || true)"
[[ "$branch" == "main" ]] || exit 0

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Never commit on main. Create a branch first, named type/NN-scope where NN is the issue number, in its own worktree (see AGENTS.md), then commit there."
  }
}'
