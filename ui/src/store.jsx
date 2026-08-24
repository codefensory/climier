import { createContext, createSignal, useContext, onMount } from "solid-js";
import { getSnapshot, getNode } from "./api.js";

const StoreContext = createContext();

export function StoreProvider(props) {
  const [snapshot, setSnapshot] = createSignal(null);
  const [error, setError] = createSignal(null);
  const [loading, setLoading] = createSignal(true);
  const [route, setRoute] = createSignal("overview");
  const [selectedId, setSelectedId] = createSignal(null);
  const [detail, setDetail] = createSignal(null);
  const [detailError, setDetailError] = createSignal(null);

  async function load() {
    setLoading(true);
    try {
      const snap = await getSnapshot();
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  onMount(load);

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
