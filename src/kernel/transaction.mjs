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

import { throwV2 } from "../contracts/errors.mjs";
import {
  EDGE_TYPES,
  validateEdge,
  blocksCyclePath,
} from "../contracts/state-invariants.mjs";

function clone(value) {
  // structuredClone is available in Node >= 17 and is the deep-clone primitive
  // we already rely on elsewhere. It handles plain objects, arrays, and the
  // JSON-safe shapes (id/title/status/initiatives/scope/...) that appear in
  // the v2 state.
  return structuredClone(value);
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function readSnapshotEdges(snapshot) {
  return Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : [];
}

function readSnapshotInitiatives(snapshot) {
  // initiatives: { name -> { desc, created_at? } }. The v2 schema keeps it
  // as a plain object; use an empty map for a partial snapshot.
  return snapshot && snapshot.initiatives && typeof snapshot.initiatives === "object" && !Array.isArray(snapshot.initiatives)
    ? snapshot.initiatives
    : {};
}

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotPlugins(snapshot) {
  return snapshot && snapshot.plugins && typeof snapshot.plugins === "object" && !Array.isArray(snapshot.plugins)
    ? snapshot.plugins
    : {};
}

function requirePluginId(pluginId, operation) {
  const id = asNonEmptyString(pluginId);
  if (!id) {
    throwV2("MISSING_FIELD", `${operation}: pluginId must be a non-empty string`, { field: "pluginId" });
  }
  return id;
}

function requireNodeId(nodeId, operation) {
  const id = asNonEmptyString(nodeId);
  if (!id) {
    throwV2("MISSING_FIELD", `${operation}: nodeId must be a non-empty string`, { field: "nodeId" });
  }
  return id;
}

function cloneValue(value, operation, field) {
  try {
    return clone(value);
  } catch (err) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${operation}: ${field} must be cloneable JSON data`, {
      field,
      cause: err && err.name ? err.name : "DataCloneError",
    });
  }
}

function findEdgeIndex(edges, predicate) {
  for (let i = 0; i < edges.length; i++) {
    if (predicate(edges[i])) return i;
  }
  return -1;
}

function edgeKey(edge) {
  return `${edge.from}|${edge.to}|${edge.type}`;
}

function hasRevisionField(input) {
  // The provider must never seed or carry revision; the kernel computes it
  // once per node per apply. We detect any property named `revision`,
  // including inherited ones via plain `in` checks on the seed object.
  return input != null && typeof input === "object" && "revision" in input;
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
  // Deep-clone the snapshot pieces we care about. log/version are owned by
  // the kernel mutation path and are not part of the draft envelope.
  const baseNodes = readSnapshotNodes(snapshot);
  const baseEdges = readSnapshotEdges(snapshot);
  const baseInitiatives = readSnapshotInitiatives(snapshot);
  // nodes: { id -> cloned node } so subsequent createNode/updateNode can
  // detect collisions and reference updates without re-cloning the snapshot
  // repeatedly. We strip `revision` on the way in because the draft is the
  // "post-apply shape" the kernel will persist: revisions are assigned once
  // per node per apply, so the draft carries no revision. This keeps
  // the snapshot vs. draft diff unambiguous and prevents any caller from
  // reaching into the draft to read stale revisions.
  const draftNodes = {};
  for (const [id, node] of Object.entries(baseNodes)) {
    const cloned = clone(node);
    delete cloned.revision;
    draftNodes[id] = cloned;
  }
  // edges: list of cloned edge objects. addEdge appends, removeEdge splices.
  const draftEdges = baseEdges.map((edge) => clone(edge));
  // initiatives: { name -> cloned initiative }. Initiatives do not carry
  // a kernel-managed revision, so the draft mirrors the snapshot 1:1 and
  // createInitiative only adds new names. Changing an existing initiative
  // is not supported by the mutation path; the add-initiative command is
  // idempotent against registered names and the kernel rejects duplicate creates
  // with ID_CONFLICT.
  const draftInitiatives = {};
  for (const [name, init] of Object.entries(baseInitiatives)) {
    draftInitiatives[name] = clone(init);
  }
  // Root plugin data is a separate typed keyspace from nodes and
  // initiatives. Keep it in the draft so project-scoped updates participate
  // in the same atomic kernel write without exposing a generic state patch.
  const draftPlugins = {};
  for (const [pluginId, entry] of Object.entries(readSnapshotPlugins(snapshot))) {
    draftPlugins[pluginId] = clone(entry);
  }

  function getNode(id) {
    const node = draftNodes[id];
    return node === undefined ? undefined : clone(node);
  }

  function createNode(input) {
    if (input == null || typeof input !== "object") {
      throwV2("MISSING_FIELD", "createNode: input must be an object", { field: "input" });
    }
    const id = asNonEmptyString(input.id);
    if (!id) {
      throwV2("MISSING_FIELD", "createNode: node requires a non-empty 'id'", { field: "id" });
    }
    const kind = asNonEmptyString(input.kind);
    if (!kind) {
      throwV2("MISSING_FIELD", "createNode: node requires a non-empty 'kind'", { field: "kind" });
    }
    if (hasRevisionField(input)) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `createNode: node '${id}' must not carry 'revision' (the kernel assigns revision once per apply)`,
        { id, field: "revision" },
      );
    }
    if (Object.prototype.hasOwnProperty.call(draftNodes, id)) {
      throwV2(
        "ID_CONFLICT",
        `createNode: node '${id}' already exists in the draft or snapshot`,
        { id, source: draftNodes[id].id === id ? "draft" : "snapshot" },
      );
    }
    // Clone the caller input so the stored draft node does not share
    // references with the caller's object. Also strips `revision` defensively
    // (we already rejected it above) and any other unexpected inherited keys
    // from the prototype chain (structuredClone handles own enumerable props).
    const stored = clone(input);
    delete stored.revision;
    draftNodes[id] = stored;
    return clone(stored);
  }

  function updateNode(id, patch) {
    const nodeId = asNonEmptyString(id);
    if (!nodeId) {
      throwV2("MISSING_FIELD", "updateNode: target id must be a non-empty string", { field: "id" });
    }
    if (patch == null || typeof patch !== "object") {
      throwV2("MISSING_FIELD", "updateNode: patch must be an object", { field: "patch" });
    }
    const existing = draftNodes[nodeId];
    if (!existing) {
      throwV2("NODE_NOT_FOUND", `updateNode: node '${nodeId}' does not exist in the draft or snapshot`, { id: nodeId });
    }
    if (hasRevisionField(patch)) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `updateNode: patch for '${nodeId}' must not carry 'revision' (the kernel increments revision once per apply)`,
        { id: nodeId, field: "revision" },
      );
    }
    // Merge without mutating the existing reference; rebuild as a fresh object
    // so callers cannot observe draft state through the patch they passed in.
    // `revision` is intentionally NOT propagated: the kernel diff compares
    // snapshot vs. draft ignoring revision to detect real changes,
    // and revision is assigned once per apply. Draft nodes therefore carry no
    // revision field; getNode/createNode/updateNode/view all reflect this.
    const merged = { ...clone(existing), ...clone(patch) };
    delete merged.revision;
    draftNodes[nodeId] = merged;
    return clone(merged);
  }

  function validateEdgeShape(edge, commandName) {
    if (edge == null || typeof edge !== "object") {
      throwV2("MISSING_FIELD", `${commandName}: edge must be an object`, { field: "edge" });
    }
    const from = asNonEmptyString(edge.from);
    if (!from) {
      throwV2("MISSING_FIELD", `${commandName}: edge requires non-empty 'from'`, { field: "from" });
    }
    const to = asNonEmptyString(edge.to);
    if (!to) {
      throwV2("MISSING_FIELD", `${commandName}: edge requires non-empty 'to'`, { field: "to" });
    }
    const type = asNonEmptyString(edge.type);
    if (!type) {
      throwV2("MISSING_FIELD", `${commandName}: edge requires non-empty 'type'`, { field: "type" });
    }
    return { from, to, type };
  }

  function resolveEdgeNode(id) {
    return draftNodes[id];
  }

  function addEdge(rawEdge) {
    const { from, to, type } = validateEdgeShape(rawEdge, "addEdge");
    const edge = { from, to, type };
    validateEdge({ nodes: draftNodes }, edge, "addEdge");
    if (type === "BLOCKS") {
      const cycle = blocksCyclePath({ edges: draftEdges }, edge);
      if (cycle) {
        throwV2(
          "CYCLE_DETECTED",
          `addEdge: BLOCKS edge ${from} -> ${to} would create a cycle`,
          { from, to, type, cycle },
        );
      }
    }
    // Duplicate detection against the current draft (snapshot + adds so far).
    const incomingKey = edgeKey({ from, to, type });
    const dupIdx = findEdgeIndex(draftEdges, (e) => edgeKey(e) === incomingKey);
    if (dupIdx !== -1) {
      throwV2(
        "DUPLICATE_EDGE",
        `addEdge: edge ${type} ${from} -> ${to} already exists`,
        { from, to, type, existing: clone(draftEdges[dupIdx]) },
      );
    }
    const stored = clone({ from, to, type });
    draftEdges.push(stored);
    return clone(stored);
  }

  function removeEdge(rawEdge) {
    const { from, to, type } = validateEdgeShape(rawEdge, "removeEdge");
    const targetKey = edgeKey({ from, to, type });
    const idx = findEdgeIndex(draftEdges, (e) => edgeKey(e) === targetKey);
    if (idx === -1) {
      // Reuse INVALID_EXECUTION_CONTRACT: the caller passed an edge shape
      // that is structurally valid but does not match any current edge.
      // Details carry the predicate the caller used so they can fix it.
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `removeEdge: no edge ${type} ${from} -> ${to} exists in the draft or snapshot`,
        { from, to, type },
      );
    }
    const [removed] = draftEdges.splice(idx, 1);
    return clone(removed);
  }

  function getNodePluginData(pluginId, nodeId) {
    const pid = requirePluginId(pluginId, "getNodePluginData");
    const nid = requireNodeId(nodeId, "getNodePluginData");
    const node = draftNodes[nid];
    if (!node) {
      throwV2("NODE_NOT_FOUND", `getNodePluginData: node '${nid}' does not exist in the draft or snapshot`, { id: nid });
    }
    const entry = node.plugins && typeof node.plugins === "object" && !Array.isArray(node.plugins)
      ? node.plugins[pid]
      : undefined;
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("data" in entry)) return undefined;
    return cloneValue(entry.data, "getNodePluginData", "data");
  }

  function setNodePluginData(pluginId, nodeId, value) {
    const pid = requirePluginId(pluginId, "setNodePluginData");
    const nid = requireNodeId(nodeId, "setNodePluginData");
    const node = draftNodes[nid];
    if (!node) {
      throwV2("NODE_NOT_FOUND", `setNodePluginData: node '${nid}' does not exist in the draft or snapshot`, { id: nid });
    }
    const plugins = node.plugins && typeof node.plugins === "object" && !Array.isArray(node.plugins)
      ? { ...node.plugins }
      : {};
    const existing = plugins[pid] && typeof plugins[pid] === "object" && !Array.isArray(plugins[pid])
      ? { ...plugins[pid] }
      : {};
    existing.data = cloneValue(value, "setNodePluginData", "value");
    plugins[pid] = existing;
    draftNodes[nid] = { ...node, plugins };
    return cloneValue(existing.data, "setNodePluginData", "value");
  }

  function deleteNodePluginData(pluginId, nodeId) {
    const pid = requirePluginId(pluginId, "deleteNodePluginData");
    const nid = requireNodeId(nodeId, "deleteNodePluginData");
    const node = draftNodes[nid];
    if (!node) {
      throwV2("NODE_NOT_FOUND", `deleteNodePluginData: node '${nid}' does not exist in the draft or snapshot`, { id: nid });
    }
    const plugins = node.plugins && typeof node.plugins === "object" && !Array.isArray(node.plugins)
      ? node.plugins
      : {};
    const entry = plugins[pid];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Object.prototype.hasOwnProperty.call(entry, "data")) {
      return false;
    }
    const nextPlugins = { ...plugins };
    const nextEntry = { ...entry };
    delete nextEntry.data;
    if (Object.keys(nextEntry).length === 0) delete nextPlugins[pid];
    else nextPlugins[pid] = nextEntry;
    draftNodes[nid] = { ...node, plugins: nextPlugins };
    return true;
  }

  function getProjectPluginData(pluginId, key) {
    const pid = requirePluginId(pluginId, "getProjectPluginData");
    const entry = draftPlugins[pid];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const data = entry.data;
    if (key === undefined) return data === undefined ? undefined : cloneValue(data, "getProjectPluginData", "data");
    const field = asNonEmptyString(key);
    if (!field) {
      throwV2("MISSING_FIELD", "getProjectPluginData: key must be a non-empty string", { field: "key" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    return Object.prototype.hasOwnProperty.call(data, field)
      ? cloneValue(data[field], "getProjectPluginData", "value")
      : undefined;
  }

  function setProjectPluginData(pluginId, key, value) {
    const pid = requirePluginId(pluginId, "setProjectPluginData");
    const field = asNonEmptyString(key);
    if (!field) {
      throwV2("MISSING_FIELD", "setProjectPluginData: key must be a non-empty string", { field: "key" });
    }
    const current = draftPlugins[pid] && typeof draftPlugins[pid] === "object" && !Array.isArray(draftPlugins[pid])
      ? { ...draftPlugins[pid] }
      : {};
    const data = current.data && typeof current.data === "object" && !Array.isArray(current.data)
      ? { ...current.data }
      : {};
    data[field] = cloneValue(value, "setProjectPluginData", "value");
    current.data = data;
    draftPlugins[pid] = current;
    return cloneValue(data[field], "setProjectPluginData", "value");
  }

  function deleteProjectPluginData(pluginId, key) {
    const pid = requirePluginId(pluginId, "deleteProjectPluginData");
    const field = asNonEmptyString(key);
    if (!field) {
      throwV2("MISSING_FIELD", "deleteProjectPluginData: key must be a non-empty string", { field: "key" });
    }
    const current = draftPlugins[pid];
    if (!current || typeof current !== "object" || Array.isArray(current) ||
        !current.data || typeof current.data !== "object" || Array.isArray(current.data) ||
        !Object.prototype.hasOwnProperty.call(current.data, field)) {
      return false;
    }
    const data = { ...current.data };
    delete data[field];
    draftPlugins[pid] = { ...current, data };
    return true;
  }

  function view(options = {}) {
    // Deep-clone the nodes and edges so the caller cannot mutate the draft
    // through the returned view. O(n) per call is acceptable: the draft is
    // pure and callers are expected to call view() once at apply time.
    const nodes = {};
    for (const [id, node] of Object.entries(draftNodes)) {
      nodes[id] = clone(node);
    }
    const initiatives = {};
    for (const [name, init] of Object.entries(draftInitiatives)) {
      initiatives[name] = clone(init);
    }
    const result = {
      nodes,
      edges: draftEdges.map((edge) => clone(edge)),
      initiatives,
    };
    // Keep the original enumerable view shape for existing graph consumers,
    // while allowing the kernel/plugin providers to request the root plugin
    // keyspace explicitly. The non-enumerable compatibility property is
    // still directly readable by callers.
    Object.defineProperty(result, "plugins", {
      value: clone(draftPlugins),
      enumerable: options && options.includePlugins === true,
      writable: false,
      configurable: false,
    });
    return result;
  }

  function pluginView() {
    return clone(draftPlugins);
  }

  function getInitiative(name) {
    const key = asNonEmptyString(name);
    if (!key) return undefined;
    const init = draftInitiatives[key];
    return init === undefined ? undefined : clone(init);
  }

  function createInitiative(input) {
    if (input == null || typeof input !== "object" || Array.isArray(input)) {
      throwV2("MISSING_FIELD", "createInitiative: input must be an object", { field: "input" });
    }
    const name = asNonEmptyString(input.name);
    if (!name) {
      throwV2("MISSING_FIELD", "createInitiative: requires non-empty 'name'", { field: "name" });
    }
    if (Object.prototype.hasOwnProperty.call(draftInitiatives, name)) {
      throwV2(
        "ID_CONFLICT",
        `createInitiative: initiative '${name}' already exists in the draft or snapshot`,
        { name },
      );
    }
    // The provider is responsible for filling desc / created_at. The draft
    // stores whatever it is given so the kernel can diff initiatives later
    // without re-reading the snapshot. desc is normalised to a string to
    // keep the diff stable when a provider passes desc: undefined.
    const stored = {};
    if (typeof input.desc === "string") stored.desc = input.desc;
    if (typeof input.created_at === "string") stored.created_at = input.created_at;
    draftInitiatives[name] = stored;
    return clone(stored);
  }

  return {
    getNode,
    createNode,
    updateNode,
    addEdge,
    removeEdge,
    getNodePluginData,
    setNodePluginData,
    deleteNodePluginData,
    getProjectPluginData,
    setProjectPluginData,
    deleteProjectPluginData,
    getInitiative,
    createInitiative,
    view,
    pluginView,
  };
}

// Export the local edge-types whitelist so the kernel mutation path can
// reuse the same source of truth without going through command adapters.
export { EDGE_TYPES };
