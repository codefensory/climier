// ui/src/store/normalize.js
//
// Pure conversion from a server snapshot to the normalized entities the
// reactive store consumes. The snapshot shape stays isolated from the
// runtime model used by views and selectors, and `normalizeSnapshot`
// guarantees it does not mutate its input.
//
// Contract:
//   - Empty input (null, undefined, non-object, missing fields) yields a
//     valid empty entities structure.
//   - Snapshot fields are deep-cloned; the input object stays untouched
//     even when callers keep a reference for diffing.
//   - `entities.plugins` is always an object; when the snapshot omits it
//     (or ships a non-object value) the result is `{}`, never `undefined`
//     or a passthrough of the source.
//   - Plugin entries are preserved under their original `pluginId` and
//     normalized to `{ data, meta? }`. A plugin entry that isn't an object
//     becomes `{ data: null }` so the host can never read an unexpected
//     shape from a plugin namespace.
//
// See .adrs/010-ui-live-store.md §3.2 / §3.6 and
// docs/plans/ui-live-store-execution.md §3.2 / §3.6 / §11.1.

function emptyEntities() {
  return { initiatives: {}, nodes: {}, edges: [], plugins: {} };
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// structuredClone handles plain data (records, arrays, primitives) and is
// available in modern browsers and Node >=17; the ui build target is
// modern, so this stays inside the runtime guarantee.
function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// Normalize a plugin namespace payload. Absent → `{}`. Non-object entries
// are defensively coerced to `{ data: null }` so downstream code can read
// `entry.data` without a presence check per plugin.
function normalizePlugins(snapshot) {
  const raw = snapshot && snapshot.plugins;
  if (raw == null) return {};
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [pluginId, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) {
      out[pluginId] = { data: null };
      continue;
    }
    const hasData = Object.prototype.hasOwnProperty.call(entry, "data");
    const hasMeta = Object.prototype.hasOwnProperty.call(entry, "meta");
    const normalized = {};
    normalized.data = hasData ? clone(entry.data) : clone(entry);
    if (hasMeta) normalized.meta = clone(entry.meta);
    out[pluginId] = normalized;
  }
  return out;
}

export function normalizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return emptyEntities();
  const initiatives = isPlainObject(snapshot.initiatives)
    ? clone(snapshot.initiatives)
    : {};
  const nodes = isPlainObject(snapshot.nodes) ? clone(snapshot.nodes) : {};
  const edges = Array.isArray(snapshot.edges) ? clone(snapshot.edges) : [];
  const plugins = normalizePlugins(snapshot);
  return { initiatives, nodes, edges, plugins };
}

// Empty entity shape, frozen so accidental mutation from a consumer is
// visible at runtime instead of silently corrupting later snapshots.
export const EMPTY_ENTITIES = Object.freeze({
  initiatives: Object.freeze({}),
  nodes: Object.freeze({}),
  edges: Object.freeze([]),
  plugins: Object.freeze({}),
});
