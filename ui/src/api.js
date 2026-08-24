// Thin fetch layer over the local climier UI API (see ui/server/server.mjs).
// All GETs take an optional AbortSignal so callers can cancel stale requests
// (selection changes, debounced search, etc.).

async function jget(url, { signal } = {}) {
  const r = await fetch(url, signal ? { signal } : undefined);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body.error?.message) msg = body.error.message;
    } catch {
      /* keep status text */
    }
    // AbortError is the caller's problem; re-throw so the store can ignore it
    // when it's an expected cancellation.
    throw new Error(msg);
  }
  return r.json();
}

export const getSnapshot = ({ signal } = {}) => jget("/api/snapshot", { signal });
export const getNode = (id, { signal } = {}) => jget(`/api/node/${encodeURIComponent(id)}`, { signal });
export const getActivity = (params = {}, { signal } = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  return jget(`/api/activity?${q}`, { signal });
};
export const search = (q, all = false, { signal } = {}) =>
  jget(`/api/search?q=${encodeURIComponent(q)}&all=${all}`, { signal });