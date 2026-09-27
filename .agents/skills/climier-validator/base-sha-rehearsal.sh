#!/usr/bin/env bash
# Repeatable regression rehearsal for stale and current submission bases.
# All commits, branches, and preflight runs live in a disposable temporary repo.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
preflight="$script_dir/integration-preflight.sh"
finish_task="$script_dir/../climier-worker/finish-task.sh"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/climier-base-sha-rehearsal.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

root="$tmp/project"
task_worktree="$tmp/stale-task"
current_worktree="$tmp/current-task"
mkdir -p "$root" "$tmp/bin"
git -C "$root" init -q -b trunk
git -C "$root" config user.name "Rehearsal Worker"
git -C "$root" config user.email "rehearsal@example.invalid"
printf 'baseline\n' > "$root/shared.txt"
git -C "$root" add shared.txt
git -C "$root" commit -qm 'X: branch point'
cut_point="$(git -C "$root" rev-parse HEAD)"
git -C "$root" worktree add -q -b work/T-rehearsal-stale-agent "$task_worktree" "$cut_point"

# Trunk advances from X to Y, touching the same path as the task branch.
printf 'trunk edit Y\n' > "$root/shared.txt"
git -C "$root" commit -qam 'Y: trunk overlap'
current_base="$(git -C "$root" rev-parse trunk)"
printf 'task edit from X\n' > "$task_worktree/shared.txt"
git -C "$task_worktree" add shared.txt
git -C "$task_worktree" commit -qm 'task edit shared file'
task_head="$(git -C "$task_worktree" rev-parse HEAD)"

# A harmless mock captures finish-task's generated EVIDENCE. No live Climier
# state or global project metadata is accessed by this throwaway rehearsal.
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'for arg in "$@"; do case "$arg" in EVIDENCE\ *) printf "%s\\n" "$arg" > "$EVIDENCE_CAPTURE";; esac; done' 'printf "{}\\n"' > "$tmp/bin/climier"
chmod +x "$tmp/bin/climier"
git -C "$task_worktree" -c user.name='Rehearsal Worker' -c user.email='rehearsal@example.invalid' commit --allow-empty -qm 'finish marker [T-v1-basesha-staleness-integrity]'
finish_output="$(cd "$task_worktree" && PATH="$tmp/bin:$PATH" EVIDENCE_CAPTURE="$tmp/finish-evidence" bash "$finish_task" T-v1-basesha-staleness-integrity rehearsal 'rehearsal only')"
finish_evidence="$(printf '%s\n' "$finish_output" | grep '^EVIDENCE ' || true)"
[[ -n "$finish_evidence" ]] || { printf 'finish-task did not emit EVIDENCE\n' >&2; exit 1; }
finished_base="$(EVIDENCE_LINE="$finish_evidence" node -e 'const x=JSON.parse(process.env.EVIDENCE_LINE.slice(9)); process.stdout.write(x.base_sha)')"
[[ "$finished_base" == "$cut_point" ]] || {
  printf 'FAIL: finish-task recorded %s; branch cut point is %s\n' "$finished_base" "$cut_point" >&2
  exit 1
}

# Verify finish-task's truthful cut point reports the advanced trunk and overlap.
if result="$(bash "$preflight" --task T-v1-basesha-staleness-integrity --project-root "$root" --json --note-text "$finish_evidence" 2>"$tmp/fresh.stderr")"; then
  fresh_status=0
else
  fresh_status=$?
fi
[[ "$fresh_status" -eq 1 ]] || { printf 'FAIL: stale branch preflight exit=%s\n%s\n' "$fresh_status" "$result" >&2; exit 1; }
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict === "clean" || x.base.divergence !== "base_advanced" || x.base.branch_contains_current_base !== false || !x.overlap_paths.includes("shared.txt")) process.exit(1);' "$result"
printf 'truthful stale case: recorded=%s cut_point=%s current=%s; ' "$finished_base" "$cut_point" "$current_base"
printf '%s\n' "$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(`verdict=${x.verdict} divergence=${x.base.divergence} overlap_paths=${JSON.stringify(x.overlap_paths)}`)' "$result")"

# Replay the incident's bad finish-time value: Y was recorded although the task
# branch does not contain Y. This disagreement must be visible, never clean.
incident_evidence="$(EVIDENCE_LINE="$finish_evidence" CURRENT_BASE="$current_base" node -e 'const x=JSON.parse(process.env.EVIDENCE_LINE.slice(9)); x.base_sha=process.env.CURRENT_BASE; process.stdout.write("EVIDENCE "+JSON.stringify(x))')"
if incident_result="$(bash "$preflight" --task T-v1-basesha-staleness-integrity --project-root "$root" --json --note-text "$incident_evidence" 2>"$tmp/incident.stderr")"; then
  incident_status=0
else
  incident_status=$?
fi
[[ "$incident_status" -eq 1 ]] || { printf 'FAIL: incident replay exit=%s\n%s\n' "$incident_status" "$incident_result" >&2; exit 1; }
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict === "clean" || x.base.divergence !== "base_sha_mismatch" || x.base.recorded_matches_cut_point !== false || x.base.branch_contains_current_base !== false || !x.overlap_paths.includes("shared.txt")) process.exit(1);' "$incident_result"
printf 'incident replay: recorded=%s cut_point=%s current=%s; ' "$current_base" "$cut_point" "$current_base"
printf '%s\n' "$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(`verdict=${x.verdict} divergence=${x.base.divergence} overlap_paths=${JSON.stringify(x.overlap_paths)}`)' "$incident_result")"

# Positive control: a task cut from current Y changes a distinct path. It must
# pass clean, proving the checker does not solve false-clean by flagging all.
git -C "$root" worktree add -q -b work/T-rehearsal-current-agent "$current_worktree" "$current_base"
printf 'task-only\n' > "$current_worktree/task-only.txt"
git -C "$current_worktree" add task-only.txt
git -C "$current_worktree" -c user.name='Rehearsal Worker' -c user.email='rehearsal@example.invalid' commit -qm 'current task change'
current_head="$(git -C "$current_worktree" rev-parse HEAD)"
current_evidence="$(node -e 'process.stdout.write("EVIDENCE "+JSON.stringify({task:"T-rehearsal-current",commit:process.argv[1],branch:"work/T-rehearsal-current-agent",worktree:process.argv[2],base_ref:"trunk",base_sha:process.argv[3],files:[{path:"task-only.txt",status:"A"}],checks:[]}))' "$current_head" "$current_worktree" "$current_base")"
current_result="$(bash "$preflight" --task T-rehearsal-current --project-root "$root" --json --note-text "$current_evidence" 2>"$tmp/current.stderr")"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict !== "clean" || x.base.divergence !== "clean" || x.base.branch_contains_current_base !== true || x.overlap_paths.length !== 0) process.exit(1);' "$current_result"
printf '%s\n' "current positive control: $(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(`verdict=${x.verdict} divergence=${x.base.divergence} branch_contains_current_base=${x.base.branch_contains_current_base} overlap_paths=${JSON.stringify(x.overlap_paths)}`)' "$current_result")"
