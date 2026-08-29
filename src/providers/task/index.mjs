// src/providers/task/index.mjs — public surface of the task provider.
//
// Plan §B4-task-core + §B4-task-lifecycle + ADR-011/012: this module is
// the single import point that the future registry (B6A) and the
// adapter (B6B) consume to bind the task provider to its operation
// ids. Core (create/update) was wired by §B4-task-core; lifecycle
// (take/resolve/release/reopen/cancel) by §B4-task-lifecycle.
//
// Constraints:
//   - pure ESM re-exports: no filesystem, no lock, no state, no log,
//     no policy, no commands, no registry, no adapter, no CLI, no UI;
//   - the providers themselves are frozen plain objects so the
//     registry can hold them by reference without worrying about
//     accidental mutation.

export { taskCreateProvider } from "./create.mjs";
export { taskUpdateProvider } from "./update.mjs";
export { taskTakeProvider } from "./take.mjs";
export { taskResolveProvider } from "./resolve.mjs";
export { taskReleaseProvider } from "./release.mjs";
export { taskReopenProvider } from "./reopen.mjs";
export { taskCancelProvider } from "./cancel.mjs";

// Canonical pure task graph semantics. The v2 facade can re-export these
// helpers without retaining a second implementation of derivation.
export {
  supersededBy,
  isSatisfiedV2,
  isTaskReady,
  isReady,
  readiness,
  collectReadyTasks,
  deriveV2,
  statusOfV2,
  isSatisfiedByGraph,
  taskIsReadyByGraph,
} from "./derivation.mjs";
