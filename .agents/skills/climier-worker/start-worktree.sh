#!/usr/bin/env bash
set -euo pipefail

# Single-source-of-truth start path for a worker. This script owns the
# preflight (clean status), the claim (climier take), and the worktree
# creation (git worktree add). The worker SKILL.md does NOT call
# worker-guard.sh separately: doing so would run the guard twice and
# re-check the same status before this script reads it.

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

# Single guard invocation: prints the project_root on stdout (captured via
# $()) and exits non-zero with a clear message if the worktree is dirty.
# Any preflight that needs project_root should call this script, not the
# guard directly.
project_root="$(bash "$script_dir/worker-guard.sh")"

safe_task_id="$(printf '%s' "$task_id" | tr -c 'A-Za-z0-9._-' '-')"
safe_agent_id="$(printf '%s' "$agent_id" | tr -c 'A-Za-z0-9._-' '-')"

# Snapshot immutable base pointers BEFORE any climier or git mutation so the
# recorded provenance reflects the tip the worktree branched from, not a
# later main HEAD.
base_ref="$(git -C "$project_root" rev-parse --abbrev-ref HEAD)"
base_sha="$(git -C "$project_root" rev-parse HEAD)"

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

# take replaces claim and prints the full context envelope (node, blocking,
# knowledge, allowed_actions). Silenced here so the WORKTREE summary is
# the only stdout on success.
if ! climier --project "$project_root" take "$task_id" --as "$agent_id" >/dev/null; then
  echo "Cannot start worktree: climier take failed for $task_id (claim was not placed)" >&2
  exit 2
fi

# Once the claim is placed, ANY failure below must release it. Otherwise
# the task carries an orphan claim until the orchestrator or validator
# intervenes. The release is best-effort: if it fails, log loudly so the
# handoff is unambiguous.
release_claim() {
  if ! climier --project "$project_root" release "$task_id" --as "$agent_id" >/dev/null 2>&1; then
    echo "Cannot start worktree: failed to release claim $task_id after error; orchestrator must intervene." >&2
  fi
}

if ! git -C "$project_root" worktree add "$worktree_path" -b "$worktree_branch"; then
  release_claim
  echo "Cannot start worktree: git worktree add failed for $task_id; claim was released." >&2
  exit 2
fi

# WORKTREE note fields:
#   path     — relative path to the worktree (validator parses this)
#   branch   — task branch name (validator parses this)
#   base     — base branch name (validator parses this; kept for compat)
#   base_ref — same as base, explicit name for the recorded base branch
#   base_sha — commit SHA captured before mutation (immutable provenance)
climier --project "$project_root" add-note "$task_id" "WORKTREE path=$worktree_path branch=$worktree_branch base=$base_ref base_ref=$base_ref base_sha=$base_sha status=started" --as "$agent_id" >/dev/null

cat <<EOF
WORKTREE path=$worktree_path
BRANCH $worktree_branch
BASE $base_ref
BASE_SHA $base_sha
NEXT cd $worktree_path
EOF
