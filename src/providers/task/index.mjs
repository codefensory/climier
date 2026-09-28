

// and their operation ids. It exposes both core operations (create/update)
// and lifecycle operations (take/resolve/release/reopen/cancel).
// Constraints:
//   - pure ESM re-exports: no filesystem, no lock, no state, no log,

//   - the providers themselves are frozen plain objects so the
//     registry can hold them by reference without worrying about
//     accidental mutation.

export { taskCreateProvider } from "./create.mjs";
export { taskUpdateProvider } from "./update.mjs";
export { taskTakeProvider } from "./take.mjs";
export { taskReleaseProvider } from "./release.mjs";
export { taskReopenProvider } from "./reopen.mjs";
export { taskCancelProvider } from "./cancel.mjs";
export { taskSubmitProvider } from "./submit.mjs";
export { taskAcceptProvider } from "./accept.mjs";
export { taskRejectProvider } from "./reject.mjs";


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
