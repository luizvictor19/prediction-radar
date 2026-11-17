#!/usr/bin/env bash
#
# PreToolUse hook for Bash: guard main and the production database.
#   - deny a git commit while the branch is main;
#   - deny a git push that targets main (bare push from main, or a refspec
#     naming main);
#   - deny any force push (--force, --force-with-lease, -f, or a +refspec);
#   - deny a git merge while the branch is main;
#   - deny a git merge of anything but origin/main. Only --no-edit, --no-ff
#     and -m <msg> may come with it; --abort or --continue alone go through;
#   - deny supabase db push outside an issue worktree: from the main folder,
#     from a worktree on main, or from a folder that is no git worktree.
# Commits, plain pushes and merges of origin/main on feature branches go
# through, and so does supabase db push from an issue worktree.
#
# The deny list in settings.json can only block or allow a command whole; it
# cannot say "only on main" or "only from a worktree". This hook says it; the
# deny list keeps rebase, hard reset and force push.
#
# Ported from chelsea-st-app, where a delivery was once committed straight on
# main and its commits never left it. The commit and push checks came here in
# PR 44 (as no-commit-on-main.sh); the merge and db push checks came with
# issue 84, when the Claude started bringing origin/main into issue branches
# and applying migrations, the same step chelsea-st-app took in its PR 324.
# scripts/hook-guards.test.ts runs this script on throwaway repositories, one
# case per check, inside the gate.
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

# The command cut into its simple commands, one per line, at && || ; | & and
# the brackets of a subshell or a substitution.
segments() {
  sed -E 's/(&&|\|\||[;|&`(){}])/\n/g' <<<"$1"
}

# git, optionally with global options (-C path, -c key=value, --no-pager, ...),
# then the subcommand. Anchored at the start or after a separator, so a
# chained "git add . && git commit" is caught as well.
git_sub() {
  printf '(^|[;&|(`{]|\\$\\()[[:space:]]*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+%s([[:space:]]|$)' "$1"
}
# The arguments of every `git <sub>` segment, one segment per line. Only the
# real segments count: text elsewhere in the command (a grep pattern, a
# commit message) never reaches the checks below.
git_args() {
  segments "$2" \
    | sed -nE "s/^[[:space:]]*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+$1([[:space:]]+|\$)//p"
}
commit="$(git_sub commit)"
push="$(git_sub push)"
merge="$(git_sub merge)"

is_commit=false; is_push=false; is_merge=false
grep -Eq "$commit" <<<"$command" && is_commit=true
grep -Eq "$push" <<<"$command" && is_push=true
grep -Eq "$merge" <<<"$command" && is_merge=true

if $is_commit || $is_push || $is_merge; then
  # A `git -C <path> ...` runs in <path>, not in the session's cwd, so the
  # branch is read from there when the flag is present.
  dir="$(grep -Eo 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' <<<"$command" | head -n1 | awk '{print $3}' || true)"
  dir="${dir/#\~/$HOME}"
  if [[ -n "$dir" && "$dir" != /* ]]; then
    dir="${cwd:-.}/$dir"
  fi
  branch="$(git -C "${dir:-${cwd:-.}}" branch --show-current 2>/dev/null || true)"
fi

if $is_commit && [[ "$branch" == "main" ]]; then
  deny "Never commit on main. Create a branch first, named type/NN-scope where NN is the issue number, in its own worktree (see AGENTS.md), then commit there."
fi

if $is_push; then
  # Checked word by word, so a +refspec or a branch named main counts only
  # as an argument of the push itself.
  pushed_main=false
  while IFS= read -r args; do
    read -r -a words <<<"$args" || true
    for w in "${words[@]}"; do
      w="${w%\"}"; w="${w#\"}"; w="${w%\'}"; w="${w#\'}"
      case "$w" in
        --force|--force=*|--force-with-lease|--force-with-lease=*|--force-if-includes|--mirror|+*)
          deny "Never force push. Push the branch normally, or ask Luiz." ;;
        -[!-]*)
          [[ "$w" == *f* ]] && deny "Never force push. Push the branch normally, or ask Luiz." ;;
        main|:main|*:main|refs/heads/main|*:refs/heads/main)
          pushed_main=true ;;
      esac
    done
  done <<<"$(git_args push "$command")"
  if $pushed_main; then
    deny "Never push to main. Push the feature branch and open a PR."
  fi
  if [[ "$branch" == "main" ]]; then
    deny "Never push from main. Switch to the feature branch and push that."
  fi
fi

if $is_merge; then
  if [[ "$branch" == "main" ]]; then
    deny "Never merge on main. main changes only through a merged PR (gh pr merge NN --merge)."
  fi
  only_origin_main="The only git merge allowed is origin/main into an issue branch: git -C <worktree> merge origin/main, with --no-edit, --no-ff or -m <msg> at most (Merge in AGENTS.md, main into the branch in docs/commands.md)."
  # A quoted message may hold spaces or separators: each quoted string
  # becomes one placeholder word before the command is cut into segments.
  unquoted="$(sed -E "s/\"[^\"]*\"/MSG/g; s/'[^']*'/MSG/g" <<<"$command")"
  while IFS= read -r args; do
    read -r -a words <<<"$args" || true
    targets=0; controls=0; message=false
    for w in "${words[@]}"; do
      if $message; then message=false; continue; fi
      case "$w" in
        --no-edit|--no-ff) ;;
        -m) message=true ;;
        -m?*) ;;
        --abort|--continue) controls=$((controls + 1)) ;;
        origin/main) targets=$((targets + 1)) ;;
        *) deny "$only_origin_main" ;;
      esac
    done
    if ! { [[ $targets -eq 1 && $controls -eq 0 ]] || [[ $controls -eq 1 && ${#words[@]} -eq 1 ]]; }; then
      deny "$only_origin_main"
    fi
  done <<<"$(git_args merge "$unquoted")"
fi

# supabase db push, optionally through npx, after environment assignments and
# global options (--workdir path, --debug, ...).
db_push_cmd='([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(npx[[:space:]]+)?supabase([[:space:]]+(--workdir[[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+db[[:space:]]+push([[:space:]]|$)'
if grep -Eq "(^|[;&|(\`{]|\\$\\()[[:space:]]*$db_push_cmd" <<<"$command"; then
  not_from_worktree="Run supabase db push from the issue's worktree, never from the main folder: cd .claude/worktrees/<type>-NN-<scope> && supabase db push (Migrations in docs/commands.md). The worktree holds the new migration file."
  # The folder each segment runs in: the session's cwd, moved by every
  # `cd <path>` segment before it.
  here="${cwd:-$PWD}"
  checked=false
  while IFS= read -r seg; do
    seg="${seg#"${seg%%[![:space:]]*}"}"
    if [[ "$seg" =~ ^cd([[:space:]]+([^[:space:]]+))?[[:space:]]*$ ]]; then
      to="${BASH_REMATCH[2]:-$HOME}"
      to="${to%\"}"; to="${to#\"}"; to="${to%\'}"; to="${to#\'}"
      to="${to/#\~/$HOME}"
      if [[ "$to" == /* ]]; then here="$to"; else here="$here/$to"; fi
    elif grep -Eq "^$db_push_cmd" <<<"$seg"; then
      checked=true
      at="$here"
      workdir="$(grep -Eo -- '--workdir[[:space:]]+[^[:space:]]+' <<<"$seg" | head -n1 | awk '{print $2}' || true)"
      if [[ -n "$workdir" ]]; then
        workdir="${workdir/#\~/$HOME}"
        if [[ "$workdir" == /* ]]; then at="$workdir"; else at="$here/$workdir"; fi
      fi
      # A linked worktree has a git dir of its own under the common one; the
      # main folder's git dir is the common dir itself.
      git_dir="$(git -C "$at" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
      common_dir="$(git -C "$at" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
      at_branch="$(git -C "$at" branch --show-current 2>/dev/null || true)"
      if [[ -z "$git_dir" || "$git_dir" == "$common_dir" || "$at_branch" == "main" ]]; then
        deny "$not_from_worktree"
      fi
    fi
  done <<<"$(segments "$command")"
  $checked || deny "$not_from_worktree"
fi

exit 0
