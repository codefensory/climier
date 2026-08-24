# Worker flow — end-to-end

A worker agent starts a session, takes a task, does the work, and resolves it.

## Setup

```bash
cd ~/Dev/climier
# (climier is on PATH via `npm link`; tasks.json was created with `climier init`)
```

## 1. Orient

```bash
$ climier status | jq '{summary, ready_ids: [.tasks.ready[].id], open_gates: [.gates.open[].id]}'
{
  "summary": { "ready": 2, "in_progress": 0, "blocked": 11, "backlog": 0, "open_gates": 4, "active_knowledge": 6 },
  "ready_ids": ["T-auth-7", "T-web-3"],
  "open_gates": ["D1", "D2", "D3", "D4"]
}
```

The worker sees: 2 tasks ready, 4 open gates blocking downstream phases. They pick one of the ready tasks.

## 2. Pre-flight check (read-only)

Before taking, run `context` to see the spec, knowledge, blockers, derived status, and a list of allowed actions. It also catches the case where another agent claimed the task between your `status` and now (or where the task has a stale claim that needs orchestrator attention).

```bash
$ climier context T-auth-7 | jq '{id: .node.id, derived_status, can_claim, blocking: [.blocking[] | select(.satisfied == false) | .node.id], allowed_actions}'
{
  "id": "T-auth-7",
  "derived_status": "ready",
  "can_claim": true,
  "blocking": [],
  "allowed_actions": ["claim", "update", "add-note", "cancel"]
}
```

No unsatisfied blockers, no stale claim — the worker proceeds. If `can_claim` had been `false`, the worker would either pick another task or stop to investigate.

## 3. Take

```bash
$ climier take T-auth-7 --as claude-shared | jq '.node | {id, status, claim, revision}'
{
  "id": "T-auth-7",
  "status": "in_progress",
  "claim": { "by": "claude-shared", "at": "2026-07-19T20:51:14.123Z" },
  "revision": 2
}
```

Now T-auth-7 is `in_progress` and claimed by `claude-shared`. No other agent can take it. `take` is idempotent — re-running with the same `--as` returns the same node with `freshly_claimed: false`.

## 4. Do the work

The worker creates `packages/shared/src/schemas/auth.ts`, defines `Session` and `SessionToken` Zod schemas, exports them. Runs `npm run typecheck` from the root to verify.

## 5. Close with a note

```bash
$ climier resolve T-auth-7 --note "Zod schemas Session/SessionToken added in packages/shared/src/schemas/auth.ts, tsc pasa" --as claude-shared | jq '.node | {id, status, done_by, done_at}'
{
  "id": "T-auth-7",
  "status": "done",
  "done_by": "claude-shared",
  "done_at": "2026-07-19T21:14:54.868Z"
}
```

`resolve` returns `{ node, newly_ready }` where `newly_ready` is the set of task ids that just transitioned from blocked to ready because of this resolution. The note is the audit trail. Future agents reading `history T-auth-7` will know what shipped.

## 6. Re-orient

```bash
$ climier status | jq '.tasks.ready[] | {id, title: .title, domain}'
{
  "id": "T-web-3",
  "title": "...",
  "domain": "web"
}
{
  "id": "T-api-12",
  "title": "...",
  "domain": "api"
}
```

After resolving T-auth-7, the worker sees T-web-3 and **T-api-12** are now ready (T-api-12 was blocked by T-auth-7). They pick T-api-12 if they have the skills.

## What if the worker gets stuck?

```bash
# Option A: leave it for another agent
$ climier release T-auth-7 --as claude-shared | jq '.released'
true

# Option B: ask the orchestrator to unblock (then release)
$ climier add-note T-auth-7 --as claude-shared "blocked: need to confirm field naming with the API team"
{
  "node": { "id": "T-auth-7", "notes": [{ "ts": "...", "agent": "claude-shared", "text": "blocked: ..." }] }
}
$ climier release T-auth-7 --as claude-shared
```

In option B, the note stays in the task's `notes[]` thread (visible via `context` and `history`) and the claim is freed. The orchestrator sees the `blocked:` note and helps.

## What if the worker dies mid-task?

Nothing breaks. The claim stays; the next session sees T-auth-7 as `in_progress` and either:
- Re-takes from a different agent (after `release` from the original agent's orchestrator, if recoverable).
- After 2h, `status` flags it as stale and the orchestrator releases it. `climier context <id>` shows `claim.stale: true` for any task you inspect.

## When the task references a research gate

Some tasks are spawned from a research gate. Their `body` starts with "Read .decisions/X first." If you see that in `context`, **read the doc before doing anything else**.

```bash
$ climier context T-api-12 | jq '{id: .node.id, derived_status, body: .node.body}'
{
  "id": "T-api-12",
  "derived_status": "ready",
  "body": "Read .decisions/D9.md first. Implement session validation per the chosen approach."
}
```

`D9` is the research gate; `.decisions/D9.md` is the file the researcher wrote. Read it:

```bash
$ cat .decisions/D9.md
# D9: Auth library research
...
Conclusion: use Lucia. Migration path: ...
```

Then proceed with the work. The doc carries the rationale + the chosen path + any pitfalls the researcher flagged. Skipping it is how decisions get re-litigated and work gets re-done.

**No `Read .decisions/...` in the body?** Then the task has no research context — proceed with `context` only.