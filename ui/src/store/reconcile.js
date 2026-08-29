// ui/src/store/reconcile.js
//
// Identity and ordering helpers that keep entity references stable across
// polls. The reactive store (ui/src/store/createStore.js, delivered by a
// later task) uses these to call `solid-js/store`'s `reconcile(value, {
// key })` per slice; this module owns the identity contract and never
// reaches for the snapshot shape or for Solid itself.
//
// Contract:
//   - Each key function returns a string stable across polls for the same
//     logical entity. Missing fields collapse to "" so consumers can rely
//     on a string return type.
//   - `stableEdges` returns a NEW array of edges sorted by `edgeKey`.
//     Edges missing `from`, `to` or `type` are dropped because they have
//     no usable identity. The input array is never mutated.
//   - `stableNodes` / `stableInitiatives` / `stablePlugins` return
//     defensive copies so callers can hand them to Solid without worrying
//     about whether the source was already a fresh object.
//
// See .adrs/010-ui-live-store.md §3.3 and
// docs/plans/ui-live-store-execution.md §3.3 / §11.1.

function asId(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

export function edgeKey(edge) {
  if (!edge || typeof edge !== "object") return "";
  return `${asId(edge.from)}::${asId(edge.to)}::${asId(edge.type)}`;
}

export function keyForNode(node) {
  if (!node || typeof node !== "object") return "";
  return asId(node.id);
}

export function keyForInitiative(nameOrEntry) {
  if (nameOrEntry == null) return "";
  if (typeof nameOrEntry === "string") return nameOrEntry;
  if (typeof nameOrEntry === "object" && typeof nameOrEntry.name === "string") {
    return nameOrEntry.name;
  }
  return "";
}

export function keyForPlugin(_entry, pluginId) {
  return asId(pluginId);
}

// Sort edges by `from::to::type`. Edges missing any of those fields are
// dropped because they have no usable identity for Solid's reconcile.
export function stableEdges(edges) {
  if (!Array.isArray(edges)) return [];
  const out = [];
  for (const e of edges) {
    if (!e || typeof e !== "object") continue;
    if (e.from == null || e.to == null || e.type == null) continue;
    out.push(e);
  }
  out.sort((a, b) => {
    const ka = edgeKey(a);
    const kb = edgeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

// Defensive copies of the entity maps. Solid's `reconcile` keeps the same
// reference when an entity hasn't changed, but it still needs the outer
// object to be a fresh value to detect "the pool changed".
export function stableNodes(nodes) {
  if (!nodes || typeof nodes !== "object") return {};
  const out = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || typeof node !== "object") continue;
    if (node.id == null) continue;
    out[id] = node;
  }
  return out;
}

export function stableInitiatives(initiatives) {
  if (!initiatives || typeof initiatives !== "object") return {};
  const out = {};
  for (const [name, entry] of Object.entries(initiatives)) {
    if (typeof name !== "string" || !name) continue;
    out[name] = entry;
  }
  return out;
}

export function stablePlugins(plugins) {
  if (!plugins || typeof plugins !== "object") return {};
  const out = {};
  for (const [pluginId, entry] of Object.entries(plugins)) {
    if (typeof pluginId !== "string" || !pluginId) continue;
    out[pluginId] = entry;
  }
  return out;
}
