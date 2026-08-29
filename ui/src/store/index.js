// ui/src/store/index.js
//
// Internal barrel for the ui/src/store/ subdirectory. The facade
// (ui/src/store.jsx) consumes this module to wire transport to the
// reactive store. Views and components must not import from here
// directly; the only public API is `useStore()` from store.jsx.
//
// See .adrs/010-ui-live-store.md §3.2 / §5 and
// docs/plans/ui-live-store-execution.md §11.3.

export { createReactiveStore } from "./createStore.js";
export {
  getDetail,
  hasDetail,
  applyDetail,
  clearDetail as clearDetailEntry,
  clearAllDetails,
} from "./detail.js";
