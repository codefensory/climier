---
name: subagents
description: Spawn parallel background sub-agents (Explore, Plan, custom) for read-only investigation, planning, or general-purpose work. Use when you need to delegate a task to another agent that runs concurrently and reports back.
---

# Subagents

Spawn sub-agents via the `subagent` tool. Foreground agents block and return results inline. Background agents return an ID immediately and notify on completion.

## Default Agent Types

| Type | Tools | Model | Description |
|---|---|---|---|
| `general-purpose` | all | inherit | Parent twin — same rules, same prompt |
| `Explore` | read, bash, grep, find, ls | haiku (falls back to inherit) | Fast read-only codebase exploration |
| `Plan` | read, bash, grep, find, ls | inherit | Software architect for planning (read-only) |

Case-insensitive: `"explore"`, `"Explore"`, `"EXPLO"` all work. Unknown types fall back to general-purpose.

## Spawning

```text
subagent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

### Parallel pattern

1. Spawn multiple agents with `run_in_background: true` — each returns an `agent_id`.
2. Do other work, or go straight to collecting results.
3. `get_subagent_result({ agent_id, wait: true })` blocks until that agent finishes.
4. If an agent is going off-track mid-run, `steer_subagent({ agent_id, message: "..." })` redirects it without restarting.

Foreground agents (`run_in_background` omitted or `false`) block until done — use when the next step depends on that result and nothing else can run in parallel.

### When to use which type

- **Explore** — codebase search, grep, read files, answer questions about existing code. Cheap (haiku). Don't use if you need to edit.
- **Plan** — same read-only tools but full model. Use for architecture decisions, implementation planning, tradeoff analysis.
- **general-purpose** — everything else: edits, writes, multi-step tasks that need the full parent context.

### `subagent` parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary (shown in UI) |
| `subagent_type` | string | yes | Agent type (built-in or custom) |
| `model` | string | no | `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`) |
| `thinking` | string | no | off, minimal, low, medium, high, xhigh |
| `max_turns` | number | no | Max agentic turns. Omit for unlimited |
| `run_in_background` | boolean | no | Run without blocking |
| `resume` | string | no | Agent ID to resume a previous session |
| `inherit_context` | boolean | no | Fork parent conversation into agent |

### `get_subagent_result`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent ID to check |
| `wait` | boolean | no | Wait for completion |
| `verbose` | boolean | no | Include full conversation log |

### `steer_subagent`

Send a message to a running agent. Interrupts after current tool execution.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Agent ID to steer |
| `message` | string | yes | Message to inject |

## Custom Agents

Define in `.pi/agents/<name>.md` (project) or `~/.pi/agent/agents/<name>.md` (global). Project overrides global. Filename = agent type name.

### Agent frontmatter

All fields optional.

| Field | Default | Description |
|---|---|---|
| `description` | filename | Agent description |
| `display_name` | — | UI display name |
| `tools` | all 7 | Comma-separated: read, bash, edit, write, grep, find, ls. `none` for no tools |
| `model` | inherit parent | `provider/modelId` or fuzzy name |
| `thinking` | inherit | off, minimal, low, medium, high, xhigh |
| `max_turns` | unlimited | `0` or omit for unlimited |
| `prompt_mode` | `append` | `replace`: body is the full prompt, no parent context bridge. `append`: parent prompt is base, body is wrapped in `<agent_instructions>` |
| `inherit_context` | `false` | Fork parent conversation |
| `run_in_background` | `false` | Run in background by default |
| `enabled` | `true` | `false` to disable an agent |

Frontmatter is authoritative — values set here are locked, `subagent` params only fill unspecified fields.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor.
Review code for vulnerabilities including:

- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

## Commands

| Command | Description |
|---|---|
| `/subagents:settings` | Configure concurrency, turn limits, grace turns |
| `/subagents:sessions` | View a subagent's session transcript (read-only) |

## Completion Notifications

When a background agent finishes, the parent receives a `<task-notification>` with the agent's ID, type, duration, token count, and result preview. Use the `agent_id` from this notification with `get_subagent_result` or `steer_subagent`.

## Concurrency

Background agents have a configurable concurrency limit (default: 4). Excess agents are queued automatically. Foreground agents bypass the queue.

## Graceful Max Turns

At `max_turns`: steering message tells agent to wrap up. Up to 5 grace turns to finish cleanly. Hard abort only after grace period.

## Persistent Settings

Two files, merged on load (project wins):

- **Global:** `~/.pi/agent/subagents.json` — machine-wide defaults
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides (written by `/subagents:settings`)

Missing fields fall back to hardcoded defaults (max concurrency `4`, max turns unlimited, grace turns `5`).
