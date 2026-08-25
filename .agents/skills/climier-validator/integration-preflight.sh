#!/usr/bin/env bash
# integration-preflight.sh — read-only preflight check for climier task worktrees.
#
# Synopsis:
#   bash .agents/skills/climier-validator/integration-preflight.sh [options]
#
# Behavior:
#   - Discovers the task id (--task or from the current branch), reads the
#     latest EVIDENCE JSON or WORKTREE key=value note from `climier context`,
#     finds the task worktree, compares recorded base_sha against the current
#     tip of base_ref, and lists files changed by the task.
#   - Reports divergence and overlap candidates (paths touched in both the
#     task branch and the project's main branch since base_sha).
#   - NEVER touches git state: no checkout, merge, reset, commit, push,
#     fetch, worktree remove, or file edits. Only read-only git inspection.
#
# Output:
#   - Human-readable summary on stderr by default.
#   - With --json, emits structured JSON on stdout.
#   - Exit codes:
#       0 = clean (no divergence, no overlap, recorded base matches current tip
#           or comparable given the recorded evidence).
#       1 = divergence OR overlap detected (validator must review before merge).
#       2 = error (missing task/worktree, malformed note, git failure, etc.).
#
# Backward compatibility:
#   - Tolerates older WORKTREE key=value notes that lack base_sha, files, and
#     checks. In degraded mode the script reports each absent field explicitly
#     instead of failing.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: bash .agents/skills/climier-validator/integration-preflight.sh [--task <id>] [--project-root <path>] [--json] [--note-text <text>]

Options:
  --task <id>           Climier task id to inspect (default: inferred from current branch).
  --project-root <path> Override the project root (default: detected via git worktree list).
  --json                Emit structured JSON on stdout; human summary still goes to stderr.
  --note-text <text>    Use the supplied note text instead of reading it from climier
                        state. Useful for tests. Must start with EVIDENCE or WORKTREE.
  -h, --help            Print this help.
EOF
}

# Defaults.
task_id=""
project_root_override=""
emit_json=0
note_text_override=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) task_id="${2-}"; shift 2 ;;
    --task=*) task_id="${1#*=}"; shift ;;
    --project-root) project_root_override="${2-}"; shift 2 ;;
    --project-root=*) project_root_override="${1#*=}"; shift ;;
    --json) emit_json=1; shift ;;
    --note-text) note_text_override="${2-}"; shift 2 ;;
    --note-text=*) note_text_override="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "integration-preflight: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# Resolve project_root (the primary worktree / canonical repo dir).
if [[ -n "$project_root_override" ]]; then
  project_root="$project_root_override"
else
  # Use current worktree (or CWD) to find project root via git worktree list.
  cwd_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$cwd_root" ]]; then
    echo "integration-preflight: not inside a git working tree" >&2
    exit 2
  fi
  project_root="$(git -C "$cwd_root" worktree list --porcelain | sed -n '1{s/^worktree //p;}')"
  if [[ -z "$project_root" ]]; then
    echo "integration-preflight: could not resolve project root from worktree list" >&2
    exit 2
  fi
fi

# Resolve task id: explicit --task wins; else from current branch pattern
# work/<task-id>-<agent>.
if [[ -z "$task_id" ]]; then
  current_branch="$(git -C "$project_root" branch --show-current 2>/dev/null || true)"
  if [[ -n "$current_branch" ]] && [[ "$current_branch" =~ ^work/(.+)-[A-Za-z0-9._-]+$ ]]; then
    task_id="${BASH_REMATCH[1]}"
  fi
fi

if [[ -z "$task_id" ]]; then
  echo "integration-preflight: cannot infer task id; pass --task <id> or run from a worktree branch named work/<task>-<agent>" >&2
  exit 2
fi

# Defense in depth: validate task id characters.
safe_task_id="$(printf '%s' "$task_id" | tr -c 'A-Za-z0-9._-' '-')"
[[ "$safe_task_id" == "$task_id" ]] || { echo "integration-preflight: invalid task id: $task_id" >&2; exit 2; }

# Read the latest note text. Prefer --note-text for testability.
note_text="$note_text_override"
note_source="override"

if [[ -z "$note_text" ]]; then
  context_json="$(climier --project "$project_root" context "$task_id" 2>/dev/null || true)"
  if [[ -z "$context_json" ]]; then
    echo "integration-preflight: failed to read climier context for $task_id" >&2
    exit 2
  fi
  # Extract the latest note text starting with EVIDENCE or WORKTREE.
  note_text="$(printf '%s' "$context_json" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const o = JSON.parse(s);
    const notes = (o && o.node && Array.isArray(o.node.notes)) ? o.node.notes : [];
    for (let i = notes.length - 1; i >= 0; i--) {
      const t = notes[i].text || "";
      if (t.startsWith("EVIDENCE ") || t.startsWith("WORKTREE ")) {
        process.stdout.write(t);
        break;
      }
    }
  } catch {}
});
')"
  note_source="climier-context"
fi

if [[ -z "$note_text" ]]; then
  echo "integration-preflight: no EVIDENCE or WORKTREE note found for $task_id (have you run start-worktree.sh / finish-task.sh yet?)" >&2
  exit 2
fi

# Detect note kind.
note_kind=""
if [[ "$note_text" == EVIDENCE* ]]; then
  note_kind="EVIDENCE"
elif [[ "$note_text" == WORKTREE* ]]; then
  note_kind="WORKTREE"
else
  echo "integration-preflight: latest note is neither EVIDENCE nor WORKTREE for $task_id" >&2
  exit 2
fi

# Parse note into a structured bag of fields. EVIDENCE notes are JSON;
# WORKTREE notes are key=value pairs.
recorded_branch=""
recorded_worktree=""
recorded_base_ref=""
recorded_base_sha=""
recorded_commit=""
recorded_files_json='[]'
recorded_checks_json='[]'
recorded_task=""
degraded_reasons=()

if [[ "$note_kind" == "EVIDENCE" ]]; then
  payload="${note_text#EVIDENCE }"
  if ! parsed="$(printf '%s' "$payload" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const o = JSON.parse(s);
    const out = {
      task: o.task || "",
      commit: o.commit || "",
      branch: o.branch || "",
      worktree: o.worktree || "",
      base_ref: o.base_ref || "",
      base_sha: o.base_sha || "",
      files: JSON.stringify(Array.isArray(o.files) ? o.files : []),
      checks: JSON.stringify(Array.isArray(o.checks) ? o.checks : []),
    };
    for (const k of Object.keys(out)) process.stdout.write(k + "=" + out[k] + "\n");
  } catch (e) {
    process.stderr.write("invalid-json:" + (e && e.message ? e.message : "parse-failed") + "\n");
    process.exit(1);
  }
});
')"; then
    echo "integration-preflight: EVIDENCE note is not valid JSON" >&2
    exit 2
  fi

  while IFS='=' read -r key value; do
    case "$key" in
      task) recorded_task="$value" ;;
      commit) recorded_commit="$value" ;;
      branch) recorded_branch="$value" ;;
      worktree) recorded_worktree="$value" ;;
      base_ref) recorded_base_ref="$value" ;;
      base_sha) recorded_base_sha="$value" ;;
      files) recorded_files_json="$value" ;;
      checks) recorded_checks_json="$value" ;;
    esac
  done <<< "$parsed"

  [[ -n "$recorded_base_ref" ]] || degraded_reasons+=("EVIDENCE has no base_ref")
  [[ -n "$recorded_base_sha" ]] || degraded_reasons+=("EVIDENCE has no base_sha (older schema); cannot detect base divergence")
else
  # WORKTREE key=value. Greedy parse; tolerate whitespace and arbitrary order.
  for token in $note_text; do
    case "$token" in
      path=*) recorded_worktree="${token#path=}" ;;
      branch=*) recorded_branch="${token#branch=}" ;;
      base=*) recorded_base_ref="${token#base=}" ;;
      commit=*) recorded_commit="${token#commit=}" ;;
    esac
  done
  degraded_reasons+=("note is WORKTREE (no EVIDENCE JSON); base_sha, files, and checks unavailable")
fi

# Resolve worktree path: prefer recorded value, then git worktree list by branch.
resolve_worktree() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 1
  if [[ "$candidate" = /* ]]; then
    [[ -d "$candidate" ]] || return 1
    printf '%s\n' "$candidate"
    return 0
  fi
  local rel="$project_root/$candidate"
  [[ -d "$rel" ]] || return 1
  printf '%s\n' "$rel"
  return 0
}

worktree_path=""
if [[ -n "$recorded_worktree" ]] && worktree_path="$(resolve_worktree "$recorded_worktree")"; then
  :
fi
if [[ -z "$worktree_path" && -n "$recorded_branch" ]]; then
  candidate_path="$(git -C "$project_root" worktree list --porcelain | awk -v br="$recorded_branch" '
    /^worktree / { p = substr($0, index($0, " ") + 1); next }
    $0 == "branch refs/heads/" br { print p; exit }
  ')"
  if [[ -n "$candidate_path" ]] && [[ -d "$candidate_path" ]]; then
    worktree_path="$candidate_path"
  fi
fi

if [[ -z "$worktree_path" ]]; then
  echo "integration-preflight: cannot locate worktree for task $task_id (branch=$recorded_branch path=$recorded_worktree)" >&2
  exit 2
fi

# Read-only git inspection from here on. NEVER use checkout/merge/reset/commit.
task_head_sha="$(git -C "$worktree_path" rev-parse HEAD 2>/dev/null || true)"
[[ -n "$task_head_sha" ]] || { echo "integration-preflight: cannot read HEAD of $worktree_path" >&2; exit 2; }

# Base ref is required for the rest.
if [[ -z "$recorded_base_ref" ]]; then
  echo "integration-preflight: no base_ref recorded for $task_id — cannot compute divergence" >&2
  exit 1
fi

current_base_sha="$(git -C "$project_root" rev-parse "$recorded_base_ref" 2>/dev/null || true)"
if [[ -z "$current_base_sha" ]]; then
  echo "integration-preflight: cannot resolve $recorded_base_ref in project root" >&2
  exit 2
fi

# Divergence analysis (only when we have a recorded base_sha).
divergence_status="unknown"
ahead_count="0"
behind_count="0"
recorded_base_match_current="false"
recorded_base_reachable="false"

if [[ -n "$recorded_base_sha" ]]; then
  if [[ "$recorded_base_sha" == "$current_base_sha" ]]; then
    recorded_base_match_current="true"
    recorded_base_reachable="true"
    divergence_status="clean"
  else
    recorded_base_match_current="false"
    if git -C "$project_root" merge-base --is-ancestor "$recorded_base_sha" "$current_base_sha" 2>/dev/null; then
      recorded_base_reachable="true"
      ahead_count="$(git -C "$project_root" rev-list --count "$recorded_base_sha..$current_base_sha" 2>/dev/null || echo 0)"
      divergence_status="base_advanced"
    elif git -C "$project_root" merge-base --is-ancestor "$current_base_sha" "$recorded_base_sha" 2>/dev/null; then
      divergence_status="base_rewound"
    else
      divergence_status="base_diverged"
    fi
  fi
fi

# How far is task ahead of current base? (informational only)
task_ahead_of_main="0"
task_ahead_of_main="$(git -C "$worktree_path" rev-list --count "$current_base_sha..$task_head_sha" 2>/dev/null || echo 0)"

# Files: prefer what's recorded in EVIDENCE; otherwise compute from diff.
files_text=""
if [[ "$note_kind" == "EVIDENCE" ]]; then
  files_text="$(printf '%s' "$recorded_files_json" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const arr = JSON.parse(s);
    for (const f of arr) {
      if (typeof f === "string") process.stdout.write(f + "\n");
      else if (f && typeof f === "object") {
        process.stdout.write((f.path || "") + "\t" + (f.status || "?") + "\n");
      }
    }
  } catch {}
});
')"
else
  files_text="$(git -C "$worktree_path" diff --name-only "$recorded_base_ref...HEAD" 2>/dev/null || true)"
fi

# Overlap: in the time since recorded_base_sha (or current base fallback), are
# any of our task files also touched by main?
overlap_files=()
if [[ -n "$recorded_base_sha" ]]; then
  compare_from="$recorded_base_sha"
else
  compare_from="$current_base_sha"
fi
main_touched="$(git -C "$project_root" diff --name-only "$compare_from..$current_base_sha" 2>/dev/null || true)"
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  path_only="${line%%	*}"
  if printf '%s\n' "$main_touched" | grep -Fxq "$path_only"; then
    overlap_files+=("$path_only")
  fi
done <<< "$files_text"

# Sanity check: recorded commit match?
recorded_commit_match="true"
if [[ -n "$recorded_commit" ]] && [[ "$recorded_commit" != "$task_head_sha" ]]; then
  recorded_commit_match="false"
fi

# Sanity check: working tree clean?
worktree_status="$(git -C "$worktree_path" status --short --untracked-files=all 2>/dev/null || true)"
worktree_clean="true"
[[ -z "$worktree_status" ]] || worktree_clean="false"

# Decide the verdict.
verdict="clean"
[[ "$recorded_commit_match" != "true" ]] && verdict="incongruent"
case "$divergence_status" in
  base_rewound|base_diverged) verdict="diverged" ;;
esac
[[ ${#overlap_files[@]} -gt 0 ]] && verdict="overlap"
[[ "$worktree_clean" != "true" ]] && verdict="dirty"

# Exit code.
case "$verdict" in
  clean) exit_code=0 ;;
  *) exit_code=1 ;;
esac

# Emit JSON if requested.
if [[ "$emit_json" -eq 1 ]]; then
  export EVIDENCE__TASK_ID="$task_id"
  export EVIDENCE__KIND="$note_kind"
  export EVIDENCE__SOURCE="$note_source"
  export EVIDENCE__BRANCH="$recorded_branch"
  export EVIDENCE__WORKTREE_PATH="$worktree_path"
  export EVIDENCE__HEAD_SHA="$task_head_sha"
  export EVIDENCE__BASE_REF="$recorded_base_ref"
  export EVIDENCE__RECORDED_BASE_SHA="$recorded_base_sha"
  export EVIDENCE__CURRENT_BASE_SHA="$current_base_sha"
  export EVIDENCE__DIVERGENCE="$divergence_status"
  export EVIDENCE__BASE_MATCH="$recorded_base_match_current"
  export EVIDENCE__BASE_REACHABLE="$recorded_base_reachable"
  export EVIDENCE__MAIN_AHEAD="$ahead_count"
  export EVIDENCE__TASK_AHEAD="$task_ahead_of_main"
  export EVIDENCE__COMMIT="$recorded_commit"
  export EVIDENCE__COMMIT_MATCH="$recorded_commit_match"
  export EVIDENCE__WORKTREE_CLEAN="$worktree_clean"
  export EVIDENCE__VERDICT="$verdict"
  export EVIDENCE__FILES_JSON="$recorded_files_json"
  export EVIDENCE__CHECKS_JSON="$recorded_checks_json"
  export EVIDENCE__OVERLAP_JSON="$(node -e '
let arr = [];
for (const a of process.argv.slice(1)) arr.push(a);
process.stdout.write(JSON.stringify(arr));
' "${overlap_files[@]+"${overlap_files[@]}"}")"
  export EVIDENCE__DEGRADED_JSON="$(node -e '
let arr = [];
for (const a of process.argv.slice(1)) arr.push(a);
process.stdout.write(JSON.stringify(arr));
' "${degraded_reasons[@]+"${degraded_reasons[@]}"}")"

  node -e '
const env = process.env;
const overlap = JSON.parse(env.EVIDENCE__OVERLAP_JSON);
const degraded = JSON.parse(env.EVIDENCE__DEGRADED_JSON);
const files = JSON.parse(env.EVIDENCE__FILES_JSON);
const checks = JSON.parse(env.EVIDENCE__CHECKS_JSON);
const out = {
  ok: true,
  task: env.EVIDENCE__TASK_ID,
  note: { kind: env.EVIDENCE__KIND, source: env.EVIDENCE__SOURCE },
  worktree: {
    path: env.EVIDENCE__WORKTREE_PATH,
    branch: env.EVIDENCE__BRANCH,
    head_sha: env.EVIDENCE__HEAD_SHA,
    clean: env.EVIDENCE__WORKTREE_CLEAN === "true",
  },
  base: {
    ref: env.EVIDENCE__BASE_REF,
    recorded_sha: env.EVIDENCE__RECORDED_BASE_SHA,
    current_sha: env.EVIDENCE__CURRENT_BASE_SHA,
    match: env.EVIDENCE__BASE_MATCH === "true",
    reachable: env.EVIDENCE__BASE_REACHABLE === "true",
    divergence: env.EVIDENCE__DIVERGENCE,
    main_ahead_of_recorded: Number(env.EVIDENCE__MAIN_AHEAD) || 0,
    task_ahead_of_current: Number(env.EVIDENCE__TASK_AHEAD) || 0,
  },
  task_commit: {
    recorded: env.EVIDENCE__COMMIT,
    head_sha: env.EVIDENCE__HEAD_SHA,
    match: env.EVIDENCE__COMMIT_MATCH === "true",
  },
  files_changed: files,
  overlap_paths: overlap,
  checks: checks,
  degraded_reasons: degraded,
  verdict: env.EVIDENCE__VERDICT,
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
'
  exit "$exit_code"
fi

# Human-readable summary on stderr (stdout stays empty by default).
{
  echo "integration-preflight: task=$task_id verdict=$verdict"
  echo "  note kind       : $note_kind (source: $note_source)"
  echo "  worktree        : $worktree_path"
  echo "  branch          : $recorded_branch"
  echo "  HEAD            : $task_head_sha"
  echo "  base ref        : $recorded_base_ref"
  echo "  recorded base   : ${recorded_base_sha:-<absent — degraded>}"
  echo "  current  base   : $current_base_sha"
  echo "  base divergence : $divergence_status (recorded==current: $recorded_base_match_current)"
  echo "  main ahead      : $ahead_count commit(s) since recorded base"
  echo "  task ahead      : $task_ahead_of_main commit(s) of new work over current base"
  echo "  HEAD == recorded: $recorded_commit_match"
  echo "  worktree clean  : $worktree_clean"

  if [[ -n "$recorded_base_sha" || "$note_kind" == "EVIDENCE" ]]; then
    if [[ -n "$files_text" ]]; then
      echo "  files changed   :"
      while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        echo "    - $f"
      done <<< "$files_text"
    else
      echo "  files changed   : <none>"
    fi
  else
    echo "  files changed   : not reported (degraded — use a task whose finish wrote EVIDENCE)"
  fi

  if [[ ${#overlap_files[@]} -gt 0 ]]; then
    echo "  overlap paths   :"
    for f in "${overlap_files[@]}"; do
      echo "    - $f"
    done
  else
    echo "  overlap paths   : <none>"
  fi

  if [[ ${#degraded_reasons[@]} -gt 0 ]]; then
    echo "  degraded        :"
    for r in "${degraded_reasons[@]}"; do
      echo "    - $r"
    done
  fi
} >&2

exit "$exit_code"
