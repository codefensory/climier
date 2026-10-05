# AGENTS.md

Project conventions for coding agents working on `climier-ui`.

Read the `climier-ui` skill before non-trivial work: `.agents/skills/climier-ui/SKILL.md` (commands, the
module-layering contract, how to run Storybook and its tests, and the DOM harness for proving a refactor did
not change the render). `docs/plan-storybook.md` is the decision log: *why* each thing is where it is, with
the measurements behind it. It is history, not a task list.

## Iconography

- **Prefer Hugeicons.** Use `@hugeicons/core-free-icons` (already a dependency) before writing a hand-drawn inline `<svg>`.
- Import icons individually — `import FooIcon from "@hugeicons/core-free-icons/FooIcon"` — and render them through the existing pattern (`navIconAssets` in `src/modules/app-shell/data/navigation.ts`, rendered by `NavGlyph` / `HugeIcon`): `viewBox="0 0 24 24"`, `fill="none"`, and the project's UI stroke weight (`1.8` at 16px, lighter for smaller sizes).
- Keep the established sizes: 16px in navigation, toolbars and switchers; 14px for inline metadata counts. Match the stroke weight to the surrounding text so icons never read heavier than their neighbors.
- Only keep a custom inline SVG when Hugeicons has no adequate equivalent — currently only the task **status hexagon** family (`StatusGlyph` in `src/modules/tasks/components/`). When you do, size and stroke it to the same optical weight as the Hugeicons.
- Never add a second icon library or a new icon dependency.
