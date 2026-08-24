---
name: climier-validator
description: Validate climier task worktrees (v2) after a worker resolves, stalls, or gets cancelled. Use when Codex must audit whether a task's worktree satisfies the contract, discover the worktree from task notes or git worktree paths containing the task id, return PASS/FAIL/BLOCKED without implementing fixes, merge only on PASS, and produce an orchestrator-ready follow-up report when correction is needed.
---

# Climier Validator (v2)

Validate one task worktree. Be fast, strict, and evidence-based. Do not fix code. Prefer an 80/20 audit that catches contract-breaking issues without redoing the worker's job.

## Contract

The validator can run after a worker resolves, stalls, gets cancelled, or after the orchestrator asks for the state of a task. It answers one question:

```text
Does the task worktree satisfy the climier task contract well enough to merge and let downstream work rely on it?
```

Possible verdicts:

- `PASS`: acceptance is satisfied, relevant checks ran or are reasonably justified, no clear regression/risk needs immediate correction, and the validator merged the worktree branch.
- `FAIL`: acceptance is missed, implementation is inconsistent with the contract, verification is absent/invalid, or a likely regression should be fixed before downstream work.
- `BLOCKED`: validation cannot be completed because the worktree cannot be found, required evidence is unavailable, commands cannot run, or the repo state is ambiguous.

Default bias: fail closed on concrete evidence, not on taste. Do not fail for optional improvements.

## Fast Path

Use the minimum context that can prove or disprove the work:

```bash
project_root="$(bash .agents/skills/climier-worker/task-context.sh --project-root)"
climier --project "$project_root" show <task-id>
climier --project "$project_root" history <task-id> --limit 20
git worktree list --porcelain
```

Default budget:

- use at most 10 shell commands before verdict, unless one command directly proves the task
- inspect at most 5 files manually by default
- do not read broad docs, architecture files, or full diffs unless the contract points to them
- stop early on structural failure: missing worktree, missing commit, dirty task changes, failed targeted check, or clear acceptance miss

Micro-task budget:

- if the task is `effort: S` and the diff is only docs, small scripts, package scripts, or local config, aim for at most 5 shell commands
- accept a documented inline worktree note (`status=inline-micro-task`) when it points at the main project root and the changed files match the task scope
- validate with the smallest evidence that proves acceptance: diff review for docs, `bash -n` for shell, JSON parse/package-script inspection for package metadata
- do not require root typecheck/lint/build for docs-only or shell-only changes unless the task explicitly requires it or the diff changes runtime code

Find the task worktree in this order:

1. Parse task notes/log for `WORKTREE path=<path> branch=<branch> base=<base>`.
2. If no note exists, search `git worktree list --porcelain` for a worktree path or branch containing `<task-id>`.
3. If multiple candidates match, choose the one whose branch/path most specifically contains the full task id; otherwise return `BLOCKED`.
4. If no candidate exists, return `BLOCKED`.

Then inspect only that worktree and only the files/checks relevant to the task:

```bash
cd <worktree-path>
git status --short
git log --oneline <base>..HEAD
git diff --stat <base>...HEAD
git diff --name-only <base>...HEAD
git diff <base>...HEAD -- <only suspicious or contract-critical paths>
```

Prefer `rg`, targeted `git diff -- <path>`, and package-level checks over broad repo scans.

Do not run `task-context.sh --docs`, broad test suites, or full-repo exploration unless the task contract requires it or the fast path leaves a concrete gap.

## Validation Checklist

Check in this order and stop as soon as a verdict is justified:

1. Worktree: identify exactly one task worktree and base branch/commit.
2. Commit state: branch has at least one commit over base, the relevant commit message ends with `[<task-id>]`, and `git status --short` is clean or explicitly justified.
3. Task state: task may be `done`, `in_progress`, blocked, canceled, or stale; validate the worktree state, not just the climier status. A `canceled` task has no merge target — return BLOCKED with the cancel reason instead of PASS/FAIL.
4. Contract: implementation matches `definition`, `acceptance`, scoped knowledge (`climier context` `knowledge[]`), any referenced docs/gates, and the gate's `--rationale` if the task is downstream of one.
5. Scope: diff is minimal and does not rewrite unrelated code, snapshots, generated files, secrets, or config without explicit task scope.
6. Integration: imports, routes, exports, package boundaries, and runtime entrypoints still line up.
7. Verification: worker ran the required commands, or you run the smallest missing command needed to validate the claim.
8. Regression risk: only obvious broken states, stale paths, missing files, type/API mismatches, skipped tests, or unhandled acceptance edge cases.

Do not require perfect architecture if the task did not ask for it. Do require the task's stated contract.
For micro-tasks, proportionality is part of the contract: fail for missing targeted evidence, not for skipping unrelated repository checks.

## Evidence Rules

- Prefer direct evidence from diffs, files, command output, and climier task metadata.
- If the done note claims a check passed but the diff suggests risk, run a targeted check.
- If a command is expensive, run the narrowest equivalent first.
- Do not inspect every changed line. Inspect the changed file list, then open only files needed to verify acceptance or obvious risk.
- Do not chase style, naming, or architecture preferences unless they violate the task contract or a scoped knowledge node.
- If validation depends on local dirty changes from another worker or a non-task worktree, report `BLOCKED` instead of guessing.
- If the task changes are not committed, return `FAIL` for incomplete worker handoff. If uncommitted files are unrelated but make validation ambiguous, return `BLOCKED`.
- Do not mutate source files, snapshots, task specs, or decisions during validation.
- Do not implement fixes. Only validation commands and merge commands are allowed.

Allowed climier mutations:

- Always append the verdict with `climier add-note <task-id> "...validation summary..." --as <validator-agent>`.
- Do not `reopen`, `update`, `release`, `resolve`, or create follow-up tasks yourself unless the orchestrator explicitly asked you to. The validator reports; the orchestrator decides.
- Use `climier context <task-id>` for a richer view (claim, revision, allowed_actions, scoped knowledge, blocking detail) when the simple `show` + `history` snapshot isn't enough.

Allowed git mutation:

- On `PASS` only, merge the validated worktree branch into the base branch with `--no-ff`.
- Never merge on `FAIL` or `BLOCKED`.
- Do not delete the worktree automatically; preserve it as audit/fix evidence.

## Failure Criteria

Return `FAIL` when any of these are true:

- The worktree has no task commit over base.
- The task commit message does not end with `[<task-id>]`.
- The worktree has uncommitted task changes.
- An acceptance criterion is not implemented or is only partially implemented.
- Required verification was skipped and a targeted check fails or cannot support the worker's claim.
- The worker changed unrelated areas in a way that creates real integration risk.
- The diff contradicts a gate's `--rationale`, a knowledge node's `mitigation`, an architecture rule, or a security rule.
- A public route, exported symbol, migration, auth boundary, or package API is left broken.
- Tests/snapshots were updated to hide a regression instead of preserving the contract.

Return `BLOCKED` instead of `FAIL` when the problem is missing evidence rather than bad work.

## Merge On PASS

When the worktree passes:

```bash
cd <main-worktree-for-base>
git checkout <base>
git merge --no-ff <branch>
climier --project "$project_root" add-note <task-id> "VALIDATION PASS path=<path> branch=<branch> base=<base> merged=true" --as <validator-agent>
```

If merge conflicts occur, return `BLOCKED` with the conflict summary. Do not resolve conflicts inside validation unless explicitly asked by the orchestrator.

## Output

Keep the report short. Start with the verdict. Maximum: 12 lines unless `FAIL` needs a follow-up task.

For `PASS`:

```text
PASS <task-id>
Evidence:
- worktree: <path>
- branch/base: <branch> / <base>
- commits: <short sha(s)>
- checked: <1-3 concrete checks>
Merge:
- merged with --no-ff: <branch> -> <base>
Residual risk:
- <only meaningful risk, or "none">
```

For `FAIL`:

```text
FAIL <task-id>
Reason:
- <specific failed criterion with file/command evidence>

Required follow-up task:
Title: <imperative fix title>
Definition: Continue in existing worktree `<path>` on branch `<branch>`. Do not create a new worktree. <what the next worker must fix, including exact files/behaviour>
Acceptance: <concrete pass criteria and commands, including committed changes with message ending `[<task-id>]`>
Suggested skills/domain/effort: <skills>, <domain>, <S|M|L>
```

For `BLOCKED`:

```text
BLOCKED <task-id>
Missing evidence:
- <what prevented validation>
Needed from orchestrator:
- <worktree path, decision, clean worktree, credentials, command approval, or task metadata>
```

## Handoff Rule

If verdict is `FAIL`, the orchestrator should create a new climier task from `Required follow-up task` and assign a worker to the same worktree/branch. The validator does not repair the issue in the same pass; separating validation from repair keeps the audit independent.
