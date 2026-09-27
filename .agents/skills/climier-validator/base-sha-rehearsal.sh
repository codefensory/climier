#!/usr/bin/env bash
# Repeatable regression rehearsal for recorded, stale, merged, and current bases.
# All commits, branches, and preflight runs live in a disposable temporary repo.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
preflight="$script_dir/integration-preflight.sh"
finish_task="$script_dir/../climier-worker/finish-task.sh"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/climier-base-sha-rehearsal.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

root="$tmp/project"
mkdir -p "$root" "$tmp/bin"
git -C "$root" init -q -b trunk
git -C "$root" config user.name "Rehearsal Worker"
git -C "$root" config user.email "rehearsal@example.invalid"
printf 'baseline\n' > "$root/shared.txt"
git -C "$root" add shared.txt
git -C "$root" commit -qm 'X: branch point'
cut_point="$(git -C "$root" rev-parse HEAD)"

# A harmless mock captures finish-task's generated EVIDENCE. No live Climier
# state or global project metadata is accessed by this throwaway rehearsal.
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'for arg in "$@"; do case "$arg" in EVIDENCE\ *) printf "%s\\n" "$arg" > "$EVIDENCE_CAPTURE";; esac; done' 'printf "{}\\n"' > "$tmp/bin/climier"
chmod +x "$tmp/bin/climier"

run_preflight() {
  local evidence="$1" expected_exit="$2" label="$3" result status
  if result="$(bash "$preflight" --task T-v1-basesha-staleness-integrity --project-root "$root" --json --note-text "$evidence" 2>"$tmp/$label.stderr")"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" -eq "$expected_exit" ]] || {
    printf 'FAIL %s: expected exit=%s got=%s\n%s\n' "$label" "$expected_exit" "$status" "$result" >&2
    return 1
  }
  printf '%s' "$result"
}

summary() {
  node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(`verdict=${x.verdict} divergence=${x.base.divergence} branch_contains_current_base=${x.base.branch_contains_current_base} recorded_cut_point=${x.base.recorded_cut_point_sha || ""} real_cut_point=${x.base.real_cut_point} overlap_paths=${JSON.stringify(x.overlap_paths)}`)' "$1"
}

# Advance trunk from X to Y with a shared-path edit and an independent path.
printf 'trunk edit Y\n' > "$root/shared.txt"
printf 'base-only Y\n' > "$root/base-only.txt"
git -C "$root" add shared.txt base-only.txt
git -C "$root" commit -qm 'Y: trunk overlap and independent change'
current_base="$(git -C "$root" rev-parse trunk)"

# Case 1: stale branch has a real path overlap; finish-task records both the
# branch cut point and the base tip against which the submission was made.
overlap_worktree="$tmp/stale-overlap"
git -C "$root" worktree add -q -b work/T-rehearsal-overlap-agent "$overlap_worktree" "$cut_point"
printf 'task edit from X\n' > "$overlap_worktree/shared.txt"
git -C "$overlap_worktree" add shared.txt
git -C "$overlap_worktree" commit -qm 'task edit shared file'
git -C "$overlap_worktree" commit --allow-empty -qm 'finish marker [T-v1-basesha-staleness-integrity]'
finish_output="$(cd "$overlap_worktree" && PATH="$tmp/bin:$PATH" EVIDENCE_CAPTURE="$tmp/finish-evidence" bash "$finish_task" T-v1-basesha-staleness-integrity rehearsal 'rehearsal only')"
finish_evidence="$(printf '%s\n' "$finish_output" | grep '^EVIDENCE ' || true)"
[[ -n "$finish_evidence" ]] || { printf 'FAIL: finish-task did not emit EVIDENCE\n' >&2; exit 1; }
finished_cut_point="$(EVIDENCE_LINE="$finish_evidence" node -e 'const x=JSON.parse(process.env.EVIDENCE_LINE.slice(9)); process.stdout.write(x.base_sha)')"
finished_evidence_base="$(EVIDENCE_LINE="$finish_evidence" node -e 'const x=JSON.parse(process.env.EVIDENCE_LINE.slice(9)); process.stdout.write(x.evidence_base_sha || "")')"
[[ "$finished_cut_point" == "$cut_point" && "$finished_evidence_base" == "$current_base" ]] || {
  printf 'FAIL: finish-task recorded cut_point=%s evidence_base=%s expected=%s/%s\n' "$finished_cut_point" "$finished_evidence_base" "$cut_point" "$current_base" >&2
  exit 1
}
overlap_result="$(run_preflight "$finish_evidence" 1 stale-overlap)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict !== "overlap" || x.base.divergence !== "base_advanced" || x.base.branch_contains_current_base !== false || !x.overlap_paths.includes("shared.txt")) process.exit(1);' "$overlap_result"
printf 'stale-with-overlap: recorded_cut_point=%s evidence_base=%s current=%s; %s\n' "$finished_cut_point" "$finished_evidence_base" "$current_base" "$(summary "$overlap_result")"

# Case 2: replay the incident's bad value (Y in the cut-point field although
# the branch does not contain Y); this must remain a visible mismatch.
incident_evidence="$(EVIDENCE_LINE="$finish_evidence" CURRENT_BASE="$current_base" node -e 'const x=JSON.parse(process.env.EVIDENCE_LINE.slice(9)); x.base_sha=process.env.CURRENT_BASE; x.cut_point_sha=process.env.CURRENT_BASE; process.stdout.write("EVIDENCE "+JSON.stringify(x))')"
incident_result="$(run_preflight "$incident_evidence" 1 incident-replay)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict === "clean" || x.base.divergence !== "base_sha_mismatch" || x.base.branch_contains_current_base !== false || !x.overlap_paths.includes("shared.txt")) process.exit(1);' "$incident_result"
printf 'incident-replay: recorded_cut_point=%s actual_cut_point=%s current=%s; %s\n' "$current_base" "$cut_point" "$current_base" "$(summary "$incident_result")"

# Case 3: stale base with no overlapping paths must still be non-clean.
no_overlap_worktree="$tmp/stale-no-overlap"
git -C "$root" worktree add -q -b work/T-rehearsal-no-overlap-agent "$no_overlap_worktree" "$cut_point"
printf 'task-only\n' > "$no_overlap_worktree/task-only.txt"
git -C "$no_overlap_worktree" add task-only.txt
git -C "$no_overlap_worktree" commit -qm 'task-only edit from X'
no_overlap_head="$(git -C "$no_overlap_worktree" rev-parse HEAD)"
no_overlap_evidence="$(node -e 'process.stdout.write("EVIDENCE "+JSON.stringify({task:"T-v1-basesha-staleness-integrity",commit:process.argv[1],branch:"work/T-rehearsal-no-overlap-agent",worktree:process.argv[2],base_ref:"trunk",base_sha:process.argv[3],evidence_base_sha:process.argv[4],files:[{path:"task-only.txt",status:"A"}],checks:[]}))' "$no_overlap_head" "$no_overlap_worktree" "$cut_point" "$cut_point")"
no_overlap_result="$(run_preflight "$no_overlap_evidence" 1 stale-no-overlap)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict === "clean" || x.base.divergence !== "base_advanced" || x.base.branch_contains_current_base !== false || x.overlap_paths.length !== 0) process.exit(1);' "$no_overlap_result"
printf 'stale-without-overlap: recorded_cut_point=%s current=%s; %s\n' "$cut_point" "$current_base" "$(summary "$no_overlap_result")"

# Validator probe: move the base ref again without changing the stale task's
# merge-base. The branch still cannot be clean and shares no changed paths.
printf 'base moved again\n' > "$root/base-moved-again.txt"
git -C "$root" add base-moved-again.txt
git -C "$root" commit -qm 'Z: move base without changing stale merge-base'
previous_base="$current_base"
current_base="$(git -C "$root" rev-parse trunk)"
moved_result="$(run_preflight "$no_overlap_evidence" 1 base-moved-unchanged-merge-base)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict === "clean" || x.base.divergence !== "base_advanced" || x.base.branch_contains_current_base !== false || x.base.real_cut_point !== process.argv[2] || x.overlap_paths.length !== 0) process.exit(1);' "$moved_result" "$cut_point"
printf 'base-moved-unchanged-merge-base: previous=%s current=%s; %s\n' "$previous_base" "$current_base" "$(summary "$moved_result")"

# Validator probe: detached task worktrees use explicit evidence identity and
# remain non-clean while stale, regardless of overlap.
detached_worktree="$tmp/detached-task"
git -C "$root" worktree add -q --detach "$detached_worktree" "$cut_point"
printf 'detached-task-only\n' > "$detached_worktree/detached-only.txt"
git -C "$detached_worktree" add detached-only.txt
git -C "$detached_worktree" -c user.name='Rehearsal Worker' -c user.email='rehearsal@example.invalid' commit -qm 'detached task-only edit'
detached_head="$(git -C "$detached_worktree" rev-parse HEAD)"
detached_evidence="$(node -e 'process.stdout.write("EVIDENCE "+JSON.stringify({task:"T-v1-basesha-staleness-integrity",commit:process.argv[1],branch:"",worktree:process.argv[2],base_ref:"trunk",base_sha:process.argv[3],cut_point_sha:process.argv[3],evidence_base_sha:process.argv[3],files:[{path:"detached-only.txt",status:"A"}],checks:[]}))' "$detached_head" "$detached_worktree" "$cut_point")"
detached_result="$(run_preflight "$detached_evidence" 1 detached-stale-worktree)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict === "clean" || x.base.branch_contains_current_base !== false || x.base.divergence !== "base_advanced") process.exit(1);' "$detached_result"
printf 'detached-stale-worktree: %s\n' "$(summary "$detached_result")"

# Validator probe: rebasing stale work onto the moved base now contains it, so
# a clean result is correct and is not a false clean.
git -C "$no_overlap_worktree" rebase -q trunk
rebased_head="$(git -C "$no_overlap_worktree" rev-parse HEAD)"
rebased_evidence="$(EVIDENCE_LINE="$no_overlap_evidence" REBASED_HEAD="$rebased_head" node -e 'const x=JSON.parse(process.env.EVIDENCE_LINE.slice(9)); x.commit=process.env.REBASED_HEAD; process.stdout.write("EVIDENCE "+JSON.stringify(x))')"
rebased_result="$(run_preflight "$rebased_evidence" 0 rebased-current-base)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict !== "clean" || x.base.branch_contains_current_base !== true) process.exit(1);' "$rebased_result"
printf 'rebased-current-base: %s\n' "$(summary "$rebased_result")"

# Case 4: integrate current trunk by merge while retaining the original recorded cut point.
# Containment is authoritative: this is clean, not a cut-point mismatch.
merge_worktree="$tmp/contained-merge"
git -C "$root" worktree add -q -b work/T-rehearsal-merge-agent "$merge_worktree" "$previous_base"
printf 'merge-task-only\n' > "$merge_worktree/merge-only.txt"
git -C "$merge_worktree" add merge-only.txt
git -C "$merge_worktree" commit -qm 'task-only before merge'
git -C "$merge_worktree" merge --no-edit -qm 'merge current trunk Y' trunk
merge_head="$(git -C "$merge_worktree" rev-parse HEAD)"
merge_evidence="$(node -e 'process.stdout.write("EVIDENCE "+JSON.stringify({task:"T-v1-basesha-staleness-integrity",commit:process.argv[1],branch:"work/T-rehearsal-merge-agent",worktree:process.argv[2],base_ref:"trunk",base_sha:process.argv[3],cut_point_sha:process.argv[3],evidence_base_sha:process.argv[4],files:[{path:"merge-only.txt",status:"A"}],checks:[]}))' "$merge_head" "$merge_worktree" "$cut_point" "$previous_base")"
merge_result="$(run_preflight "$merge_evidence" 0 contained-through-merge)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict !== "clean" || x.base.divergence !== "clean" || x.base.branch_contains_current_base !== true || x.base.recorded_matches_cut_point !== false || x.overlap_paths.length !== 0) process.exit(1);' "$merge_result"
printf 'contained-through-merge: recorded_cut_point=%s current=%s; %s\n' "$cut_point" "$current_base" "$(summary "$merge_result")"

# Case 5: current-base positive control stays clean.
current_worktree="$tmp/current-task"
git -C "$root" worktree add -q -b work/T-rehearsal-current-agent "$current_worktree" "$current_base"
printf 'current-task-only\n' > "$current_worktree/current-only.txt"
git -C "$current_worktree" add current-only.txt
git -C "$current_worktree" commit -qm 'current task change'
current_head="$(git -C "$current_worktree" rev-parse HEAD)"
current_evidence="$(node -e 'process.stdout.write("EVIDENCE "+JSON.stringify({task:"T-v1-basesha-staleness-integrity",commit:process.argv[1],branch:"work/T-rehearsal-current-agent",worktree:process.argv[2],base_ref:"trunk",base_sha:process.argv[3],evidence_base_sha:process.argv[3],files:[{path:"current-only.txt",status:"A"}],checks:[]}))' "$current_head" "$current_worktree" "$current_base")"
current_result="$(run_preflight "$current_evidence" 0 current-positive)"
node -e 'const x=JSON.parse(process.argv[1]); if (x.verdict !== "clean" || x.base.divergence !== "clean" || x.base.branch_contains_current_base !== true || x.overlap_paths.length !== 0) process.exit(1);' "$current_result"
printf 'current-positive-control: %s\n' "$(summary "$current_result")"
