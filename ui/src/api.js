// Thin fetch layer over the local climier UI API (see ui/server/server.mjs).

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body.error?.message) msg = body.error.message;
    } catch {
      /* keep status text */
    }
    throw new Error(msg);
  }
  return r.json();
}

export const getSnapshot = () => jget("/api/snapshot");
export const getNode = (id) => jget(`/api/node/${encodeURIComponent(id)}`);
export const getActivity = (params = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  return jget(`/api/activity?${q}`);
};
export const search = (q, all = false) => jget(`/api/search?q=${encodeURIComponent(q)}&all=${all}`);
