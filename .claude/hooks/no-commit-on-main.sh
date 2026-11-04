#!/usr/bin/env bash
#
# PreToolUse hook for Bash: protect main.
#   - deny a git commit while the branch is main;
#   - deny a git push that targets main (bare push from main, or a refspec
#     naming main);
#   - deny any force push (--force, --force-with-lease, -f, or a +refspec).
# Commits and plain pushes on feature branches go through.
#
# The deny list in settings.json can only block or allow a command whole; it
# cannot say "only on main". This hook is the "only on main"; the deny list
# keeps merge, rebase and hard reset.
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

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# git, optionally with global options (-C path, -c key=value, --no-pager, ...),
# then the subcommand. Anchored at the start or after a separator, so a
# chained "git add . && git commit" is caught as well.
git_sub() {
  printf '(^|[;&|(`{]|\\$\\()[[:space:]]*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+%s([[:space:]]|$)' "$1"
}
commit="$(git_sub commit)"
push="$(git_sub push)"

is_commit=false; is_push=false
grep -Eq "$commit" <<<"$command" && is_commit=true
grep -Eq "$push" <<<"$command" && is_push=true
$is_commit || $is_push || exit 0

# A `git -C <path> ...` runs in <path>, not in the session's cwd, so the
# branch is read from there when the flag is present.
dir="$(grep -Eo 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' <<<"$command" | head -n1 | awk '{print $3}' || true)"
dir="${dir/#\~/$HOME}"
if [[ -n "$dir" && "$dir" != /* ]]; then
  dir="${cwd:-.}/$dir"
fi
branch="$(git -C "${dir:-${cwd:-.}}" branch --show-current 2>/dev/null || true)"

if $is_commit && [[ "$branch" == "main" ]]; then
  deny "Never commit on main. Create a branch first, named type/NN-scope where NN is the issue number, in its own worktree (see AGENTS.md), then commit there."
fi

if $is_push; then
  if grep -Eq '(^|[[:space:]])(--force|--force-with-lease|--force-if-includes|-f|--mirror)([[:space:]=]|$)|[[:space:]]\+[^[:space:]]+' <<<"$command"; then
    deny "Never force push. Push the branch normally, or ask Luiz."
  fi
  if grep -Eq '(^|[[:space:]:])(refs/heads/)?main([[:space:]]|$)' <<<"$command"; then
    deny "Never push to main. Push the feature branch and open a PR."
  fi
  if [[ "$branch" == "main" ]]; then
    deny "Never push from main. Switch to the feature branch and push that."
  fi
fi

exit 0
