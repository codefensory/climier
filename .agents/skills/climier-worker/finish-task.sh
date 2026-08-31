#!/usr/bin/env bash
# finish-task.sh — worker close-out for a claimed climier task.
#
# Validates that the worktree is clean, the last commit ends with [<task-id>],
# then emits:
#   - a backward-compatible WORKTREE note (key=value) for legacy validators,
#   - a structured EVIDENCE JSON note appended via `climier add-note` so the
#     the validator protocol can run `integration-preflight.sh` against it,
#   - and finally `climier submit <id> --note "..."` to send the task to validation.
#
# Optional caller-supplied evidence:
#   - Pass --evidence-file <path> (4th positional or flag) to use a JSON file
#     the caller already prepared. The file's contents are parsed, validated,
#     and merged with auto-detected fields (commit, branch, worktree, base_ref,
#     base_sha, files). Caller values for `task`, `commit`, `branch`, `worktree`,
#     `base_ref`, and `base_sha` are passed through unless obviously wrong.
#   - Caller-supplied `files` and `checks` arrays are preserved as-is; otherwise
#     the script auto-fills `files` from `git diff --name-status base_ref HEAD`
#     and leaves `checks` empty. Task metadata is opaque and is never executed.
#
# The EVIDENCE note text is `EVIDENCE <compact JSON>` — single-line, JSON-
# parseable, and structured for `integration-preflight.sh`.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: bash .agents/skills/climier-worker/finish-task.sh <task-id> <agent-id> "<submission-note>" [--evidence-file <path>]

Emits a back-compat WORKTREE note, an EVIDENCE JSON note, and submits the task.
EOF
}

if [[ $# -lt 3 ]] || [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
  if [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then usage; exit 0; fi
  usage
  exit 1
fi

task_id="$1"
agent_id="$2"
submission_note="$3"
shift 3
evidence_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence-file) evidence_file="${2-}"; shift 2 ;;
    --evidence-file=*) evidence_file="${1#*=}"; shift ;;
    *) echo "finish-task: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

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
base_sha="$(git -C "$project_root" rev-parse "$base_branch" 2>/dev/null || echo "")"

# 1. Legacy WORKTREE note (back-compat — keep exact format). Echo to stdout
# AFTER the add-note succeeds so callers (validator, integration-preflight,
# orchestrator) can see exactly what was logged without re-querying state.
worktree_note="WORKTREE path=$current_root branch=$branch base=$base_branch commit=$commit_sha status=ready-for-validation"
climier --project "$project_root" add-note "$task_id" "$worktree_note" --as "$agent_id" >/dev/null
printf '%s\n' "$worktree_note"

# 2. EVIDENCE note. Single-line JSON, prefixed with EVIDENCE so the validator
# script can pick it up via simple prefix matching. We build it in node so
# quoting stays safe.
files_status_json="$(git -C "$current_root" diff --name-status "$base_branch...HEAD" 2>/dev/null | awk -F'\t' '
  NF >= 2 { status=$1; path=$2; printf("{\"path\":\"%s\",\"status\":\"%s\"}\n", path, status) }
  NF == 1 { printf("{\"path\":\"%s\",\"status\":\"?\"}\n", $1) }
' | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const lines = s.split("\n").filter(Boolean);
  process.stdout.write("[" + lines.join(",") + "]");
});
')"

# Checks are explicit evidence only. Task metadata remains opaque to this helper;
# callers must provide any checks through --evidence-file.
checks_json='[]'

# Build and emit the EVIDENCE note text. If the caller supplied --evidence-file,
# its object is merged in via node (caller fields win on conflict).
if [[ -n "$evidence_file" ]]; then
  if [[ ! -f "$evidence_file" ]]; then
    echo "finish-task: --evidence-file not found: $evidence_file" >&2
    exit 2
  fi
  caller_json="$(cat "$evidence_file")"
  evidence_note_text="$(TASK_ID="$task_id" COMMIT_SHA="$commit_sha" BRANCH="$branch" CURRENT_ROOT="$current_root" BASE_BRANCH="$base_branch" BASE_SHA="$base_sha" FILES_JSON="$files_status_json" CHECKS_JSON="$checks_json" CALLER_JSON="$caller_json" node -e '
const env = process.env;
let caller = {};
try { caller = JSON.parse(env.CALLER_JSON); } catch { caller = {}; }
let files = [];
try { files = JSON.parse(env.FILES_JSON); } catch { files = []; }
let checks = [];
try { checks = JSON.parse(env.CHECKS_JSON); } catch { checks = []; }
const out = {
  task: typeof caller.task === "string" ? caller.task : env.TASK_ID,
  commit: typeof caller.commit === "string" ? caller.commit : env.COMMIT_SHA,
  branch: typeof caller.branch === "string" ? caller.branch : env.BRANCH,
  worktree: typeof caller.worktree === "string" ? caller.worktree : env.CURRENT_ROOT,
  base_ref: typeof caller.base_ref === "string" ? caller.base_ref : env.BASE_BRANCH,
  base_sha: typeof caller.base_sha === "string" ? caller.base_sha : env.BASE_SHA,
  files: Array.isArray(caller.files) ? caller.files : files,
  checks: Array.isArray(caller.checks) ? caller.checks : checks,
};
const json = JSON.stringify(out);
if (typeof process.send === "function") {
  process.stdout.write(`EVIDENCE ${json}`);
} else {
  process.stdout.write(`EVIDENCE ${json}`);
}
')"
else
  evidence_note_text="$(TASK_ID="$task_id" COMMIT_SHA="$commit_sha" BRANCH="$branch" CURRENT_ROOT="$current_root" BASE_BRANCH="$base_branch" BASE_SHA="$base_sha" FILES_JSON="$files_status_json" CHECKS_JSON="$checks_json" node -e '
const env = process.env;
let files = [];
try { files = JSON.parse(env.FILES_JSON); } catch { files = []; }
let checks = [];
try { checks = JSON.parse(env.CHECKS_JSON); } catch { checks = []; }
const out = {
  task: env.TASK_ID,
  commit: env.COMMIT_SHA,
  branch: env.BRANCH,
  worktree: env.CURRENT_ROOT,
  base_ref: env.BASE_BRANCH,
  base_sha: env.BASE_SHA,
  files,
  checks,
};
process.stdout.write(`EVIDENCE ${JSON.stringify(out)}`);
')"
fi

# Validate that the note text parses as JSON before we send it through add-note
# (defensive: surfaces malformed caller evidence before mutating state).
case "$evidence_note_text" in
  "EVIDENCE "*)
    payload="${evidence_note_text#EVIDENCE }"
    if ! printf '%s' "$payload" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => { try { JSON.parse(s); } catch { process.exit(1); } });
' >/dev/null 2>&1; then
      echo "finish-task: constructed EVIDENCE JSON failed to parse; refusing to add-note" >&2
      exit 2
    fi
    ;;
  *)
    echo "finish-task: EVIDENCE note text does not start with EVIDENCE marker" >&2
    exit 2
    ;;
esac

climier --project "$project_root" add-note "$task_id" "$evidence_note_text" --as "$agent_id" >/dev/null
# Echo to stdout (after add-note succeeds) so callers/tests can capture it
# without re-reading climier state. Matches the WORKTREE note visibility.
printf '%s\n' "$evidence_note_text"

# 3. Submit. Evidence is complete before the lifecycle transition so the
# validator can audit the submitted task independently. Submission returns the
# updated node; acceptance is deliberately owned by the validator after merge.
submit_output="$(climier --project "$project_root" submit "$task_id" --note "$submission_note; commit $commit_sha" --as "$agent_id")"
printf '%s\n' "$submit_output"

cat <<EOF
SUBMITTED task=$task_id
COMMIT $commit_sha
WORKTREE $current_root
BRANCH $branch
EOF
