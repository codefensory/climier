

// and their operation ids. It exposes both core operations (create/update)
// and lifecycle operations (take/resolve/release/reopen/cancel).
// Constraints:
//   - pure ESM re-exports: no filesystem, no lock, no state, no log,

//   - the providers themselves are frozen plain objects so the
//     registry can hold them by reference without worrying about
//     accidental mutation.

export { taskCreateProvider } from "./create.ts";
export { taskUpdateProvider } from "./update.ts";
export { taskTakeProvider } from "./take.ts";
export { taskReleaseProvider } from "./release.ts";
export { taskReopenProvider } from "./reopen.ts";
export { taskCancelProvider } from "./cancel.ts";
export { taskSubmitProvider } from "./submit.ts";
export { taskAcceptProvider } from "./accept.ts";
export { taskRejectProvider } from "./reject.ts";


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
} from "./derivation.ts";
