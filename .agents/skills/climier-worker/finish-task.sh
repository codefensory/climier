#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash .agents/skills/climier-worker/finish-task.sh <task-id> <agent-id> \"<done-note>\"" >&2
}

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

task_id="$1"
agent_id="$2"
done_note="$3"

current_root="$(git rev-parse --show-toplevel)"
project_root="$(git -C "$current_root" worktree list --porcelain | sed -n '1{s/^worktree //p;}')"
status="$(git -C "$current_root" status --short --untracked-files=all)"

if [[ -n "$status" ]]; then
  {
    echo "NO-GO finish: hay cambios pendientes sin commitear."
    echo "El worker debe commitear todos los cambios de la task antes de finalizar."
    echo
    echo "git status --short --untracked-files=all:"
    echo "$status"
  } >&2
  exit 2
fi

commit_sha="$(git -C "$current_root" rev-parse HEAD)"
commit_message="$(git -C "$current_root" log -1 --format=%B)"
commit_message_trimmed="$(printf '%s' "$commit_message" | sed -e ':a' -e '/[[:space:]]$/ { s/[[:space:]]$//; ba; }')"

if [[ ! "$commit_message_trimmed" =~ \[$task_id\]$ ]]; then
  {
    echo "NO-GO finish: el ultimo commit no termina con [$task_id]."
    echo "El worker debe crear o corregir un commit cuyo mensaje cierre exactamente esta task."
    echo
    echo "commit: $commit_sha"
    echo "message:"
    printf '%s\n' "$commit_message"
  } >&2
  exit 2
fi

branch="$(git -C "$current_root" branch --show-current)"
base_branch="$(git -C "$project_root" branch --show-current)"

# add-note unchanged. resolve replaces done and accepts --note
# (instead of a positional arg). Resolve returns {node, newly_ready}; we
# echo the JSON so callers can inspect it, then surface newly_ready as a
# single line for the orchestrator.
climier --project "$project_root" add-note "$task_id" "WORKTREE path=$current_root branch=$branch base=$base_branch commit=$commit_sha status=ready-for-validation" --as "$agent_id" >/dev/null
resolve_output="$(climier --project "$project_root" resolve "$task_id" --note "$done_note; commit $commit_sha" --as "$agent_id")"
printf '%s\n' "$resolve_output"

cat <<EOF
DONE task=$task_id
COMMIT $commit_sha
WORKTREE $current_root
BRANCH $branch
EOF

# Surface newly_ready if non-empty — orchestrator signal.
newly_ready="$(printf '%s' "$resolve_output" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const o = JSON.parse(s);
    process.stdout.write(Array.isArray(o.newly_ready) ? o.newly_ready.join(" ") : "");
  } catch {}
});
')"
[[ -n "$newly_ready" ]] && printf 'NEWLY_READY %s\n' "$newly_ready"
