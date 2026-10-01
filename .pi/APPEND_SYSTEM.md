# Project guidance for Pi

Pi 0.99.1 appends this file to its built-in system prompt. Keep this file append-only: it does not replace the base prompt.

- Treat the repository, tests, and current task context as the source of truth; inspect before asserting.
- Ordinary small or local work may use the direct path with a minimal diff and proportional checks.
- Select the controlled workflow for meaningful risk, coordination, public contracts, or an explicit user request.
- Use `.agents/skills/climier/SKILL.md` for the DAG and runner contract.
- Use `.agents/skills/spec-pipeline/SKILL.md` only when a real decision warrants RFC/review/ADR planning.
- Use `.agents/skills/initiative-execution/SKILL.md` only when initiative-wide coordination is explicitly selected.
- A task already registered for runner execution must use `climierflow run <task-id>`; do not reproduce its lifecycle stages manually.
