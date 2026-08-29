// src/providers/task/index.mjs — public surface of the task-core provider.
//
// Plan §B4-task-core + ADR-011/012: this module is the single import
// point that the future registry (B6A) and the adapter (B6B) consume to
// bind the task-core provider to its operation ids. Today only
// `task.create` and `task.update` are wired (lifecycle operations
// belong to §B4-task-lifecycle).
//
// Constraints:
//   - pure ESM re-exports: no filesystem, no lock, no state, no log,
//     no policy, no commands, no registry, no adapter, no CLI, no UI;
//   - the providers themselves are frozen plain objects so the
//     registry can hold them by reference without worrying about
//     accidental mutation.

export { taskCreateProvider } from "./create.mjs";
export { taskUpdateProvider } from "./update.mjs";
