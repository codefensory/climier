# Project guidance for Pi

Pi appends this file to its built-in system prompt. Keep this file append-only: it does not replace the base prompt.

- Treat the repository, tests, and current task context as the source of truth; inspect before asserting.
- Ordinary small or local work may use the direct path with a minimal diff and proportional checks.
- Select the controlled workflow for meaningful risk, coordination, public contracts, or an explicit user request.
- Use the global `climier` skill for the DAG (tasks, gates, knowledge, initiatives, dependencies).
- Use the global `climier-flow` skill to execute tasks through the `climier_flow` tool; never invoke Flow through shell.
- Use the global `initiative-execution` skill only when initiative-wide coordination is explicitly selected.
- Use the project `spec-pipeline` skill only when a real decision warrants RFC/review/ADR planning; its long-form docs live in `.decisions/` and `.adrs/`.
- In Pi, use `climier_flow` with `action: "run"`, `"resume"`, `"restart"`, `"cancel"`, `"status"`, or `"list"`.
