// src/kernel/transaction.mjs — pure draft transaction for the graph kernel.
//
// ADR-011 §2: the in-memory draft that providers and `kernel.mutate` use
// to compose a logical mutation (nodes + edges) without
// touching the filesystem, locks, the persisted state, or the log.
//
// Contract:
//   - createTransaction(snapshot) returns a transaction whose accessors
//     (getNode/createNode/updateNode/addEdge/removeEdge/view) operate on a
//     deep clone of the input snapshot.
//   - Every accessor returns a freshly cloned value. Caller mutations cannot
//     leak into the draft and the draft cannot leak back to the caller.
//   - createNode refuses to seed a node that already carries `revision`.
//     updateNode refuses to apply a patch that carries `revision`. The
//     kernel (not the provider) owns revision increment; ADR-011 §2.
//   - Edges are validated against the union of the snapshot and the draft
//     (snapshot + draft are the only authoritative view during apply).
//   - No filesystem, no locks, no updateState, no log writes, no providers,
//     no registry, no adapters, no commands, no UI. Only structured errors
//     via ../contracts/errors.mjs.
//
// This module is deliberately self-contained: it imports only the pure
// contracts and keeps every draft primitive local, so the draft cannot
// acquire an I/O or adapter dependency. The file is organised as draft
// primitives -> accessor groups -> createTransaction composition.

import { throwV2 } from "../contracts/errors.mjs";
import { EDGE_TYPES, validateEdge, blocksCyclePath } from "../contracts/state-invariants.mjs";

// --- draft primitives ------------------------------------------------------

function clone(value) {
  // structuredClone is available in Node >= 17 and is the deep-clone primitive
  // we already rely on elsewhere. It handles plain objects, arrays, and the
  // JSON-safe shapes (id/title/status/initiatives/scope/...) that appear in
  // the v2 state.
  return structuredClone(value);
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function asNonEmptyString(value) { return typeof value === "string" && value.length > 0 ? value : null; }

function readSnapshotNodes(snapshot) { return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {}; }

function readSnapshotEdges(snapshot) { return Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : []; }

function readSnapshotInitiatives(snapshot) {
  // initiatives: { name -> { desc, created_at? } }. The v2 schema keeps it
  // as a plain object; use an empty map for a partial snapshot.
  return isRecord(snapshot && snapshot.initiatives) ? snapshot.initiatives : {};
}

function readSnapshotPlugins(snapshot) { return isRecord(snapshot && snapshot.plugins) ? snapshot.plugins : {}; }

function cloneValue(value, operation, field) {
  try {
    return clone(value);
  } catch (err) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${operation}: ${field} must be cloneable JSON data`, { field, cause: err && err.name ? err.name : "DataCloneError" });
  }
}

function requireNonEmpty(value, operation, field) {
  const text = asNonEmptyString(value);
  if (!text) {
    throwV2("MISSING_FIELD", `${operation}: ${field} must be a non-empty string`, { field });
  }
  return text;
}

function requirePluginId(pluginId, operation) { return requireNonEmpty(pluginId, operation, "pluginId"); }

function requireNodeId(nodeId, operation) { return requireNonEmpty(nodeId, operation, "nodeId"); }

function requireKey(key, operation) { return requireNonEmpty(key, operation, "key"); }

function requireDraftNode(draft, nodeId, operation) {
  const node = draft.nodes[nodeId];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${operation}: node '${nodeId}' does not exist in the draft or snapshot`, { id: nodeId });
  }
  return node;
}

function cloneNodes(baseNodes) {
  // nodes: { id -> cloned node } so subsequent createNode/updateNode can
  // detect collisions and reference updates without re-cloning the snapshot
  // repeatedly. We strip `revision` on the way in because the draft is the
  // "post-apply shape" the kernel will persist: revisions are assigned once
  // per node per apply, so the draft carries no revision. This keeps
  // the snapshot vs. draft diff unambiguous and prevents any caller from
  // reaching into the draft to read stale revisions.
  const nodes = {};
  for (const [id, node] of Object.entries(baseNodes)) {
    const cloned = clone(node);
    delete cloned.revision;
    nodes[id] = cloned;
  }
  return nodes;
}

function cloneEntries(baseEntries) {
  // initiatives and root plugin data are both plain name -> value maps.
  // Initiatives do not carry a kernel-managed revision, so the draft mirrors
  // the snapshot 1:1 and createInitiative only adds new names. Changing an
  // existing initiative is not supported by the mutation path; the
  // add-initiative command is idempotent against registered names and the
  // kernel rejects duplicate creates with ID_CONFLICT.
  const entries = {};
  for (const [key, value] of Object.entries(baseEntries)) {
    entries[key] = clone(value);
  }
  return entries;
}

function createDraft(snapshot) {
  // Deep-clone the snapshot pieces we care about. log/version are owned by
  // the kernel mutation path and are not part of the draft envelope. Root
  // plugin data is a separate typed keyspace from nodes and initiatives:
  // keeping it in the draft lets project-scoped updates participate in the
  // same atomic kernel write without exposing a generic state patch.
  return {
    nodes: cloneNodes(readSnapshotNodes(snapshot)),
    edges: readSnapshotEdges(snapshot).map((edge) => clone(edge)),
    initiatives: cloneEntries(readSnapshotInitiatives(snapshot)),
    plugins: cloneEntries(readSnapshotPlugins(snapshot)),
  };
}

function hasRevisionField(input) {
  // The provider must never seed or carry revision; the kernel computes it
  // once per node per apply. We detect any property named `revision`,
  // including inherited ones via plain `in` checks on the seed object.
  return input !== null && input !== undefined && typeof input === "object" && "revision" in input;
}

// --- node accessors --------------------------------------------------------

function nodeAccessors(draft) {
  return {
    getNode: (id) => readNode(draft, id),
    createNode: (input) => insertNode(draft, input),
    updateNode: (id, patch) => patchNode(draft, id, patch),
  };
}

function readNode(draft, id) {
  const node = draft.nodes[id];
  return node === undefined ? undefined : clone(node);
}

function insertNode(draft, input) {
  if (input === null || typeof input !== "object") {
    throwV2("MISSING_FIELD", "createNode: input must be an object", { field: "input" });
  }
  const id = asNonEmptyString(input.id);
  if (!id) {
    throwV2("MISSING_FIELD", "createNode: node requires a non-empty 'id'", { field: "id" });
  }
  if (!asNonEmptyString(input.kind)) {
    throwV2("MISSING_FIELD", "createNode: node requires a non-empty 'kind'", { field: "kind" });
  }
  if (hasRevisionField(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `createNode: node '${id}' must not carry 'revision' (the kernel assigns revision once per apply)`, { id, field: "revision" });
  }
  if (Object.prototype.hasOwnProperty.call(draft.nodes, id)) {
    throwV2("ID_CONFLICT", `createNode: node '${id}' already exists in the draft or snapshot`, { id, source: draft.nodes[id].id === id ? "draft" : "snapshot" });
  }
  // Clone the caller input so the stored draft node does not share
  // references with the caller's object. Also strips `revision` defensively
  // (we already rejected it above) and any other unexpected inherited keys
  // from the prototype chain (structuredClone handles own enumerable props).
  const stored = clone(input);
  delete stored.revision;
  draft.nodes[id] = stored;
  return clone(stored);
}

function patchNode(draft, id, patch) {
  const nodeId = asNonEmptyString(id);
  if (!nodeId) {
    throwV2("MISSING_FIELD", "updateNode: target id must be a non-empty string", { field: "id" });
  }
  if (patch === null || typeof patch !== "object") {
    throwV2("MISSING_FIELD", "updateNode: patch must be an object", { field: "patch" });
  }
  const existing = draft.nodes[nodeId];
  if (!existing) {
    throwV2("NODE_NOT_FOUND", `updateNode: node '${nodeId}' does not exist in the draft or snapshot`, { id: nodeId });
  }
  if (hasRevisionField(patch)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `updateNode: patch for '${nodeId}' must not carry 'revision' (the kernel increments revision once per apply)`, { id: nodeId, field: "revision" });
  }
  // Merge without mutating the existing reference; rebuild as a fresh object
  // so callers cannot observe draft state through the patch they passed in.
  // `revision` is intentionally NOT propagated: the kernel diff compares
  // snapshot vs. draft ignoring revision to detect real changes,
  // and revision is assigned once per apply. Draft nodes therefore carry no
  // revision field; getNode/createNode/updateNode/view all reflect this.
  const merged = { ...clone(existing), ...clone(patch) };
  delete merged.revision;
  draft.nodes[nodeId] = merged;
  return clone(merged);
}

// --- edge accessors --------------------------------------------------------

function edgeAccessors(draft) {
  return {
    addEdge: (edge) => insertEdge(draft, edge),
    removeEdge: (edge) => dropEdge(draft, edge),
  };
}

function requireEdgeField(value, commandName, field) {
  const text = asNonEmptyString(value);
  if (!text) {
    throwV2("MISSING_FIELD", `${commandName}: edge requires non-empty '${field}'`, { field });
  }
  return text;
}

function validateEdgeShape(edge, commandName) {
  if (edge === null || edge === undefined || typeof edge !== "object") {
    throwV2("MISSING_FIELD", `${commandName}: edge must be an object`, { field: "edge" });
  }
  return {
    from: requireEdgeField(edge.from, commandName, "from"),
    to: requireEdgeField(edge.to, commandName, "to"),
    type: requireEdgeField(edge.type, commandName, "type"),
  };
}

function findEdgeIndex(edges, predicate) {
  for (let i = 0; i < edges.length; i++) {
    if (predicate(edges[i])) {
      return i;
    }
  }
  return -1;
}

function edgeKey(edge) { return `${edge.from}|${edge.to}|${edge.type}`; }

function insertEdge(draft, rawEdge) {
  const { from, to, type } = validateEdgeShape(rawEdge, "addEdge");
  const edge = { from, to, type };
  validateEdge({ nodes: draft.nodes }, edge, "addEdge");
  if (type === "BLOCKS") {
    const cycle = blocksCyclePath({ edges: draft.edges }, edge);
    if (cycle) {
      throwV2("CYCLE_DETECTED", `addEdge: BLOCKS edge ${from} -> ${to} would create a cycle`, { from, to, type, cycle });
    }
  }
  // Duplicate detection against the current draft (snapshot + adds so far).
  const incomingKey = edgeKey(edge);
  const dupIdx = findEdgeIndex(draft.edges, (e) => edgeKey(e) === incomingKey);
  if (dupIdx !== -1) {
    throwV2("DUPLICATE_EDGE", `addEdge: edge ${type} ${from} -> ${to} already exists`, { from, to, type, existing: clone(draft.edges[dupIdx]) });
  }
  const stored = clone({ from, to, type });
  draft.edges.push(stored);
  return clone(stored);
}

function dropEdge(draft, rawEdge) {
  const { from, to, type } = validateEdgeShape(rawEdge, "removeEdge");
  const targetKey = edgeKey({ from, to, type });
  const idx = findEdgeIndex(draft.edges, (e) => edgeKey(e) === targetKey);
  if (idx === -1) {
    // Reuse INVALID_EXECUTION_CONTRACT: the caller passed an edge shape
    // that is structurally valid but does not match any current edge.
    // Details carry the predicate the caller used so they can fix it.
    throwV2("INVALID_EXECUTION_CONTRACT", `removeEdge: no edge ${type} ${from} -> ${to} exists in the draft or snapshot`, { from, to, type });
  }
  const [removed] = draft.edges.splice(idx, 1);
  return clone(removed);
}

// --- plugin data accessors -------------------------------------------------

function nodePluginDataAccessors(draft) {
  return {
    getNodePluginData: (pluginId, nodeId) => readNodePluginData(draft, pluginId, nodeId),
    setNodePluginData: (pluginId, nodeId, value) => writeNodePluginData(draft, pluginId, nodeId, value),
    deleteNodePluginData: (pluginId, nodeId) => removeNodePluginData(draft, pluginId, nodeId),
  };
}

function projectPluginDataAccessors(draft) {
  return {
    getProjectPluginData: (pluginId, key) => readProjectPluginData(draft, pluginId, key),
    setProjectPluginData: (pluginId, key, value) => writeProjectPluginData(draft, pluginId, key, value),
    deleteProjectPluginData: (pluginId, key) => removeProjectPluginData(draft, pluginId, key),
  };
}

function readNodePluginData(draft, pluginId, nodeId) {
  const pid = requirePluginId(pluginId, "getNodePluginData");
  const node = requireDraftNode(draft, requireNodeId(nodeId, "getNodePluginData"), "getNodePluginData");
  const entry = isRecord(node.plugins) ? node.plugins[pid] : undefined;
  if (!isRecord(entry) || !("data" in entry)) {
    return undefined;
  }
  return cloneValue(entry.data, "getNodePluginData", "data");
}

function writeNodePluginData(draft, pluginId, nodeId, value) {
  const pid = requirePluginId(pluginId, "setNodePluginData");
  const nid = requireNodeId(nodeId, "setNodePluginData");
  const node = requireDraftNode(draft, nid, "setNodePluginData");
  const plugins = isRecord(node.plugins) ? { ...node.plugins } : {};
  const existing = isRecord(plugins[pid]) ? { ...plugins[pid] } : {};
  existing.data = cloneValue(value, "setNodePluginData", "value");
  plugins[pid] = existing;
  draft.nodes[nid] = { ...node, plugins };
  return cloneValue(existing.data, "setNodePluginData", "value");
}

function removeNodePluginData(draft, pluginId, nodeId) {
  const pid = requirePluginId(pluginId, "deleteNodePluginData");
  const nid = requireNodeId(nodeId, "deleteNodePluginData");
  const node = requireDraftNode(draft, nid, "deleteNodePluginData");
  const plugins = isRecord(node.plugins) ? node.plugins : {};
  const entry = plugins[pid];
  if (!isRecord(entry) || !Object.prototype.hasOwnProperty.call(entry, "data")) {
    return false;
  }
  const nextPlugins = { ...plugins };
  const nextEntry = { ...entry };
  delete nextEntry.data;
  if (Object.keys(nextEntry).length === 0) {
    delete nextPlugins[pid];
  } else {
    nextPlugins[pid] = nextEntry;
  }
  draft.nodes[nid] = { ...node, plugins: nextPlugins };
  return true;
}

function readProjectPluginData(draft, pluginId, key) {
  const pid = requirePluginId(pluginId, "getProjectPluginData");
  const entry = draft.plugins[pid];
  if (!isRecord(entry)) {
    return undefined;
  }
  const data = entry.data;
  if (key === undefined) {
    return data === undefined ? undefined : cloneValue(data, "getProjectPluginData", "data");
  }
  const field = requireKey(key, "getProjectPluginData");
  if (!isRecord(data)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(data, field)
    ? cloneValue(data[field], "getProjectPluginData", "value")
    : undefined;
}

function writeProjectPluginData(draft, pluginId, key, value) {
  const pid = requirePluginId(pluginId, "setProjectPluginData");
  const field = requireKey(key, "setProjectPluginData");
  const current = isRecord(draft.plugins[pid]) ? { ...draft.plugins[pid] } : {};
  const data = isRecord(current.data) ? { ...current.data } : {};
  data[field] = cloneValue(value, "setProjectPluginData", "value");
  current.data = data;
  draft.plugins[pid] = current;
  return cloneValue(data[field], "setProjectPluginData", "value");
}

function removeProjectPluginData(draft, pluginId, key) {
  const pid = requirePluginId(pluginId, "deleteProjectPluginData");
  const field = requireKey(key, "deleteProjectPluginData");
  const current = draft.plugins[pid];
  if (!isRecord(current) || !isRecord(current.data) || !Object.prototype.hasOwnProperty.call(current.data, field)) {
    return false;
  }
  const data = { ...current.data };
  delete data[field];
  draft.plugins[pid] = { ...current, data };
  return true;
}

// --- initiative accessors and views ---------------------------------------

function initiativeAccessors(draft) {
  return {
    getInitiative: (name) => readInitiative(draft, name),
    createInitiative: (input) => insertInitiative(draft, input),
  };
}

function readInitiative(draft, name) {
  const key = asNonEmptyString(name);
  if (!key) {
    return undefined;
  }
  const init = draft.initiatives[key];
  return init === undefined ? undefined : clone(init);
}

function insertInitiative(draft, input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("MISSING_FIELD", "createInitiative: input must be an object", { field: "input" });
  }
  const name = asNonEmptyString(input.name);
  if (!name) {
    throwV2("MISSING_FIELD", "createInitiative: requires non-empty 'name'", { field: "name" });
  }
  if (Object.prototype.hasOwnProperty.call(draft.initiatives, name)) {
    throwV2("ID_CONFLICT", `createInitiative: initiative '${name}' already exists in the draft or snapshot`, { name });
  }
  // The provider is responsible for filling desc / created_at. The draft
  // stores whatever it is given so the kernel can diff initiatives later
  // without re-reading the snapshot. desc is normalised to a string to
  // keep the diff stable when a provider passes desc: undefined.
  const stored = {};
  if (typeof input.desc === "string") {
    stored.desc = input.desc;
  }
  if (typeof input.created_at === "string") {
    stored.created_at = input.created_at;
  }
  draft.initiatives[name] = stored;
  return clone(stored);
}

function viewDraft(draft, options = {}) {
  // Deep-clone the nodes and edges so the caller cannot mutate the draft
  // through the returned view. O(n) per call is acceptable: the draft is
  // pure and callers are expected to call view() once at apply time.
  const nodes = {};
  for (const [id, node] of Object.entries(draft.nodes)) {
    nodes[id] = clone(node);
  }
  const initiatives = {};
  for (const [name, init] of Object.entries(draft.initiatives)) {
    initiatives[name] = clone(init);
  }
  const result = { nodes, edges: draft.edges.map((edge) => clone(edge)), initiatives };
  // Keep the original enumerable view shape for existing graph consumers,
  // while allowing the kernel/plugin providers to request the root plugin
  // keyspace explicitly. The non-enumerable compatibility property is
  // still directly readable by callers.
  Object.defineProperty(result, "plugins", {
    value: clone(draft.plugins),
    enumerable: options.includePlugins === true,
    writable: false,
    configurable: false,
  });
  return result;
}

/**
 * Create a new transaction draft from the given snapshot.
 *
 * The snapshot is cloned once on entry; subsequent mutations through the
 * returned accessors operate on the draft only. The returned object
 * intentionally exposes no commit/abort surface; commit/abort belongs to
 * `kernel.mutate`.
 *
 * @param {object} snapshot - v2 state snapshot with { nodes, edges, ... }.
 * @returns {{
 *   getNode: (id: string) => object | undefined,
 *   createNode: (input: object) => object,
 *   updateNode: (id: string, patch: object) => object,
 *   addEdge: (edge: { from: string, to: string, type: string }) => object,
 *   removeEdge: (edge: { from: string, to: string, type: string }) => object,
 *   getInitiative: (name: string) => object | undefined,
 *   createInitiative: (input: { name: string, desc?: string, created_at?: string }) => object,
 *   view: () => { nodes: object, edges: object[], initiatives: object }
 * }}
 */
export function createTransaction(snapshot) {
  const draft = createDraft(snapshot);
  return {
    ...nodeAccessors(draft),
    ...edgeAccessors(draft),
    ...nodePluginDataAccessors(draft),
    ...projectPluginDataAccessors(draft),
    ...initiativeAccessors(draft),
    view: (options) => viewDraft(draft, options),
    pluginView: () => clone(draft.plugins),
  };
}

// Export the local edge-types whitelist so the kernel mutation path can
// reuse the same source of truth without going through command adapters.
export { EDGE_TYPES };
