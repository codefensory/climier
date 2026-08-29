// ui/src/store.jsx
//
// Public façade of the climier UI store. Re-exports `StoreProvider` and
// `useStore` and preserves the legacy 14-key contract so existing views
// keep working untouched:
//
//   snapshot, error, loading, initialLoading, refreshing, snapshotError,
//   lastSuccessfulAt, route, setRoute, selectedId, select, detail,
//   detailError, reload
//
// Internally the façade wires three collaborators:
//
//   ui/src/store/transport.js  — polling transport (createTransport)
//   ui/src/store/createStore.js — reactive store with slices
//                                transport / ui / entities / views / details
//   ui/src/store/index.js      — barrel re-exporting the above
//
// `snapshot()` returns the raw server payload verbatim (its legacy shape:
// { project, initiatives, nodes, edges, derived, last_activity,
// initiative_summary, summary, alerts, recent_activity, generated_at,
// plugins? }). The reactive store's slices keep entity identity stable
// across polls; views keep using the raw snapshot because they read many
// top-level fields (project, summary, alerts, last_activity, etc.) that
// do not belong to entities. Selection, detail and reload are routed
// through the transport; their results land in both the façade signals
// (so consumers see them via useStore()) and the reactive store (so a
// later migration to store.ui.* / store.details[id] finds them ready).
//
// See .adrs/010-ui-live-store.md §2 / §3.2 and
// docs/plans/ui-live-store-execution.md §3.1 / §3.2 / §3.5 / §11.4.

import { createContext, createSignal, useContext, onMount, onCleanup } from "solid-js";

import { createTransport } from "./store/transport.js";
import { createReactiveStore } from "./store/createStore.js";

const StoreContext = createContext();

export function StoreProvider(props) {
  const { store, actions } = createReactiveStore();

  // Raw server payload. Preserved as-is so the public `snapshot()`
  // accessor keeps returning the legacy shape: { project, initiatives,
  // nodes, edges, derived, last_activity, initiative_summary, summary,
  // alerts, recent_activity, generated_at, plugins? }. The reactive
  // store splits the same data into slices for stable identity, but
  // consumers that read multiple top-level fields rely on the raw
  // object to keep working unchanged.
  const [rawSnapshot, setRawSnapshot] = createSignal(null);

  // UI-only signals. `route` / `setRoute`, `selectedId`, `detail` and
  // `detailError` are local to the façade and keep their original
  // setter / getter shape (route is a Solid signal whose setter is
  // exposed as setRoute; selectedId is the raw getter). The transport
  // and reactive store are kept in sync via the callback wiring below.
  const [route, setRoute] = createSignal("overview");
  const [selectedId, setSelectedId] = createSignal(null);
  const [detail, setDetail] = createSignal(null);
  const [detailError, setDetailError] = createSignal(null);

  // Mirror of the latest `select(id)` call. The transport hands back
  // detail payloads without an id, so the façade uses this to land the
  // payload in `details[id]` of the reactive store.
  let currentSelectId = null;

  const transport = createTransport({
    onSnapshot(snap) {
      setRawSnapshot(snap);
      actions.ingestSnapshot(snap);
    },
    onSnapshotError(message) {
      actions.setTransportSnapshotError(message);
    },
    onLastSuccessfulAt(iso) {
      actions.setTransportLastSuccessfulAt(iso);
    },
    onInitialLoading(value) {
      actions.setTransportInitialLoading(value);
    },
    onRefreshing(value) {
      actions.setTransportRefreshing(value);
    },
    onDetail(node) {
      // Resolve the id from the active selection; the detail payload
      // also carries `node.id`, so fall back to it if the selection has
      // been cleared mid-flight.
      const id =
        currentSelectId || (node && node.node && node.node.id) || null;
      if (id) {
        actions.ingestDetail(id, node);
      }
      setDetail(node);
      setDetailError(null);
    },
    onDetailError(message) {
      setDetailError(message);
    },
    onDetailClear() {
      setDetail(null);
      setDetailError(null);
    },
  });

  onMount(() => {
    transport.start();
  });
  onCleanup(() => {
    transport.stop();
  });

  function select(id) {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    currentSelectId = id || null;
    transport.select(id);
  }

  function reload() {
    transport.reload();
  }

  // Public façade. Mirrors the legacy contract exactly: same 14 keys,
  // same getter / setter shape for the signals, same `error` and
  // `loading` legacy aliases backed by the reactive transport slice.
  const facade = {
    snapshot: rawSnapshot,
    error: () => store.transport.snapshotError,
    loading: () => store.transport.initialLoading,
    initialLoading: () => store.transport.initialLoading,
    refreshing: () => store.transport.refreshing,
    snapshotError: () => store.transport.snapshotError,
    lastSuccessfulAt: () => store.transport.lastSuccessfulAt,
    route,
    setRoute,
    selectedId,
    select,
    detail,
    detailError,
    reload,
  };

  return <StoreContext.Provider value={facade}>{props.children}</StoreContext.Provider>;
}

export function useStore() {
  return useContext(StoreContext);
}
