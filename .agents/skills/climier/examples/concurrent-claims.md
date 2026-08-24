# Concurrent claims — what happens when 2 agents race

Climier uses a file lock (sits next to the state file — `~/.climier/projects/<project_id>/.lock`) to make `take` atomic. Two agents trying to take the same task at the same time: exactly one wins.

## The race

In the canonical workflow both workers should have already run `context T-auth-7` and seen `can_claim: true`. The race is in `take`:

```bash
# Worker A
climier take T-auth-7 --as agent-A &

# Worker B (fired a few ms later)
climier take T-auth-7 --as agent-B &

wait
```

What happens:

1. Agent A opens the lock file (atomic `wx`).
2. Agent A reads state, sees T-auth-7 is `open` and ready.
3. Agent A writes state with T-auth-7 `in_progress` + `claim.by: agent-A`, bumps `revision`.
4. Agent A closes the lock.
5. Agent B was spinning waiting for the lock; now acquires it.
6. Agent B reads state, sees T-auth-7 is `in_progress` and claimed.
7. Agent B errors with a structured JSON error to stdout: `{"ok": false, "error": {"code": "ALREADY_CLAIMED", "message": "take: node T-auth-7 is claimed by agent-A", "details": {"id": "T-auth-7", "owner": "agent-A"}}}` (exit 1).

## The result

- Exactly one worker holds the claim.
- The other worker sees a structured error and can pick another task from `status.tasks.ready`.

## Verified by tests

The climier test suite has `concurrent-claims.test.mjs` (and the v2 variants in `v2-*.test.mjs`) that spawn two child processes taking the same task in parallel and asserts exactly one succeeds. This runs on every `npm test` in the climier repo.

## For the orchestrator: don't pre-assign

The orchestrator should NOT decide "this worker takes T-X, that worker takes T-Y" and tell both to take. Instead, the orchestrator fires both `take` commands — the lock guarantees only one wins, and the other can fall back to another task. This avoids the orchestrator having to track "did agent-A actually take T-X?"

If the orchestrator wants to guarantee agent-A wins over agent-B for a specific task, they can either:

- Tell agent-A to take first and only tell agent-B to take after agent-A confirms success, or
- Use `climier take <id> --as orchestrator` to take it themselves first, then have a worker `release` it back to the pool before re-taking under their own agent id (rare; usually not worth the coordination).

## If you see the lock file stuck

`~/.climier/projects/<project_id>/.lock` should NOT exist after a `take` completes. If it does, the previous process crashed holding the lock. Climier's `withLock` has a 10s default timeout; if a process dies, the next `take` will spin for 10s, then time out. The stale lock file can be safely removed manually:

```bash
rm ~/.climier/projects/<project_id>/.lock
```

Note: this is the ceiling of using a file lock. If a project ever needs cross-machine coordination or a long-running claim, switch to a real lock service. For single-machine multi-agent, this is fine.

The lock file lives next to the state file inside `~/.climier/projects/<project_id>/` — **not** inside the repo. Don't grep for it from the project root.