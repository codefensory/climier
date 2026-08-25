import { createContext, createSignal, useContext, onMount, onCleanup } from "solid-js";
import { getSnapshot, getNode } from "./api.js";

const POLL_MS = 2000;

const StoreContext = createContext();

// Monotonic token used to discard stale poll responses. Each new poll/request
// bumps the counter; responses whose counter has been bumped past are
// dropped silently. Combined with AbortController (which cancels the
// in-flight fetch) this prevents old responses from clobbering newer UI
// state when the user is clicking around faster than the network.
function nextToken() {
  nextToken.n = (nextToken.n || 0) + 1;
  return nextToken.n;
}

export function StoreProvider(props) {
  const [snapshot, setSnapshot] = createSignal(null);
  // initialLoading = true until the first successful snapshot lands.
  // refreshing = true for every in-flight background poll (including the
  // first, but views should prefer initialLoading for the splash).
  const [initialLoading, setInitialLoading] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [snapshotError, setSnapshotError] = createSignal(null);
  const [lastSuccessfulAt, setLastSuccessfulAt] = createSignal(null);
  const [route, setRoute] = createSignal("overview");
  const [selectedId, setSelectedId] = createSignal(null);
  const [detail, setDetail] = createSignal(null);
  const [detailError, setDetailError] = createSignal(null);

  let pollToken = 0;
  let detailToken = 0;
  let pollAbort = null;
  let detailAbort = null;
  let timer = null;
  let hasGoodSnapshot = false;

  function isAbortError(err) {
    return err && (err.name === "AbortError" || err.code === 20 /* ABORT_ERR */);
  }

  // Loads the snapshot. Preserves the previous snapshot on a refresh
  // failure so the UI doesn't blank out, and bumps a token so a slow
  // earlier poll can't overwrite a fast later one.
  async function load() {
    const token = nextToken();
    pollAbort?.abort();
    const controller = new AbortController();
    pollAbort = controller;
    if (!hasGoodSnapshot) setInitialLoading(true);
    setRefreshing(true);
    try {
      const snap = await getSnapshot({ signal: controller.signal });
      if (token < pollToken) return; // a newer poll already won
      pollToken = token;
      setSnapshot(snap);
      setSnapshotError(null);
      setLastSuccessfulAt(new Date().toISOString());
      hasGoodSnapshot = true;
    } catch (e) {
      if (isAbortError(e)) return;
      if (token < pollToken) return;
      pollToken = token;
      // Keep the previous snapshot; just surface the error so the view can
      // render a banner.
      setSnapshotError(e.message);
    } finally {
      if (token === pollToken) {
        setRefreshing(false);
        setInitialLoading(false);
      }
    }
  }

  // Refreshes the open node detail in place (no loading flash).
  async function refreshDetail(id) {
    if (!id) return;
    const token = nextToken();
    detailAbort?.abort();
    const controller = new AbortController();
    detailAbort = controller;
    try {
      const node = await getNode(id, { signal: controller.signal });
      if (token < detailToken) return;
      detailToken = token;
      setDetail(node);
      setDetailError(null);
    } catch (e) {
      if (isAbortError(e)) return;
      if (token < detailToken) return;
      detailToken = token;
      setDetailError(e.message);
    }
  }

  function poll() {
    load();
    refreshDetail(selectedId());
  }

  function onVisible() {
    if (document.visibilityState === "visible") poll();
  }

  onMount(load);
  onMount(() => {
    timer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  });
  onCleanup(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    pollAbort?.abort();
    detailAbort?.abort();
  });

  async function select(id) {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    if (!id) return;
    refreshDetail(id);
  }

  const store = {
    snapshot,
    error: snapshotError, // legacy alias kept for back-compat with existing views
    loading: initialLoading, // legacy alias; views that only need the splash use this
    initialLoading,
    refreshing,
    snapshotError,
    lastSuccessfulAt,
    route,
    setRoute,
    selectedId,
    select,
    detail,
    detailError,
    reload: load,
  };
  return <StoreContext.Provider value={store}>{props.children}</StoreContext.Provider>;
}

export function useStore() {
  return useContext(StoreContext);
}