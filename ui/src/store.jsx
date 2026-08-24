import { createContext, createSignal, useContext, onMount, onCleanup } from "solid-js";
import { getSnapshot, getNode } from "./api.js";

const POLL_MS = 2000;

const StoreContext = createContext();

export function StoreProvider(props) {
  const [snapshot, setSnapshot] = createSignal(null);
  const [error, setError] = createSignal(null);
  const [loading, setLoading] = createSignal(true);
  const [route, setRoute] = createSignal("overview");
  const [selectedId, setSelectedId] = createSignal(null);
  const [detail, setDetail] = createSignal(null);
  const [detailError, setDetailError] = createSignal(null);

  let inflight = false;
  let timer = null;

  // Loads the snapshot. Only shows the "Loading…" state on the very first
  // load; background polls swap the data in place without flashing.
  async function load() {
    if (inflight) return;
    inflight = true;
    if (!snapshot()) setLoading(true);
    try {
      const snap = await getSnapshot();
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      inflight = false;
      setLoading(false);
    }
  }

  // Refreshes the open node detail in place (no loading flash).
  async function refreshDetail(id) {
    if (!id) return;
    try {
      setDetail(await getNode(id));
      setDetailError(null);
    } catch (e) {
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
  });

  async function select(id) {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    if (!id) return;
    try {
      setDetail(await getNode(id));
    } catch (e) {
      setDetailError(e.message);
    }
  }

  const store = { snapshot, error, loading, route, setRoute, selectedId, select, detail, detailError, reload: load };
  return <StoreContext.Provider value={store}>{props.children}</StoreContext.Provider>;
}

export function useStore() {
  return useContext(StoreContext);
}
