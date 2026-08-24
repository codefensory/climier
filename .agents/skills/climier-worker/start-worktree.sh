#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash .agents/skills/climier-worker/start-worktree.sh <task-id> <agent-id>" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

task_id="$1"
agent_id="$2"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(bash "$script_dir/worker-guard.sh")"

safe_task_id="$(printf '%s' "$task_id" | tr -c 'A-Za-z0-9._-' '-')"
safe_agent_id="$(printf '%s' "$agent_id" | tr -c 'A-Za-z0-9._-' '-')"
base_branch="$(git -C "$project_root" branch --show-current)"
worktree_path="../climier-worktrees/$safe_task_id-$safe_agent_id"
worktree_branch="work/$safe_task_id-$safe_agent_id"
worktree_parent="$(dirname "$worktree_path")"

if git -C "$project_root" show-ref --verify --quiet "refs/heads/$worktree_branch"; then
  echo "Cannot start worktree: branch already exists: $worktree_branch" >&2
  exit 2
fi

if [[ -e "$project_root/$worktree_path" ]]; then
  echo "Cannot start worktree: path already exists: $worktree_path" >&2
  exit 2
fi

mkdir -p "$project_root/$worktree_parent"

# v2 surface: take replaces claim. take's response already includes the full
# context envelope (node, blocking, knowledge, allowed_actions) so a separate
# context call is redundant. Print silenced so the WORKTREE summary is the
# only thing on stdout.
climier --project "$project_root" take "$task_id" --as "$agent_id" >/dev/null
git -C "$project_root" worktree add "$worktree_path" -b "$worktree_branch"
climier --project "$project_root" add-note "$task_id" "WORKTREE path=$worktree_path branch=$worktree_branch base=$base_branch status=started" --as "$agent_id" >/dev/null

cat <<EOF
WORKTREE path=$worktree_path
BRANCH $worktree_branch
BASE $base_branch
NEXT cd $worktree_path
EOF
