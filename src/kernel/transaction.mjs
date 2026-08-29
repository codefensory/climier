// src/kernel/transaction.mjs — pure draft transaction for the graph kernel.
//
// ADR-011 §2 + plan B1a: the in-memory draft that providers and the future
// `kernel.mutate` use to compose a logical mutation (nodes + edges) without
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
//     via ../errors.mjs.

import { throwV2 } from "../errors.mjs";

// Edge types accepted by mutating commands (matches v2.mjs EDGE_TYPES; inlined
// here so the kernel module has no dependency on v2.mjs / commands).
const EDGE_TYPES = Object.freeze(["BLOCKS", "SUPERSEDES", "DERIVED_FROM"]);

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

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
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
  // once per node per apply (B1b). We detect any property named `revision`,
  // including inherited ones via plain `in` checks on the seed object.
  return input != null && typeof input === "object" && "revision" in input;
}

/**
 * Create a new transaction draft from the given snapshot.
 *
 * The snapshot is cloned once on entry; subsequent mutations through the
 * returned accessors operate on the draft only. The returned object
 * intentionally exposes no commit/abort surface — that lives in B1b
 * (`kernel.mutate`).
 *
 * @param {object} snapshot - v2 state snapshot with { nodes, edges, ... }.
 * @returns {{
 *   getNode: (id: string) => object | undefined,
 *   createNode: (input: object) => object,
 *   updateNode: (id: string, patch: object) => object,
 *   addEdge: (edge: { from: string, to: string, type: string }) => object,
 *   removeEdge: (edge: { from: string, to: string, type: string }) => object,
 *   view: () => { nodes: object, edges: object[] }
 * }}
 */
export function createTransaction(snapshot) {
  // Deep-clone the snapshot pieces we care about. initiatives/log are owned
  // by the kernel mutation path and are not part of the draft envelope.
  const baseNodes = readSnapshotNodes(snapshot);
  const baseEdges = readSnapshotEdges(snapshot);
  // nodes: { id -> cloned node } so subsequent createNode/updateNode can
  // detect collisions and reference updates without re-cloning the snapshot
  // repeatedly. We strip `revision` on the way in because the draft is the
  // "post-apply shape" the kernel will persist: revisions are assigned once
  // per node per apply (B1b), so the draft carries no revision. This keeps
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
    // `revision` is intentionally NOT propagated: the kernel diff (B1b)
    // compares snapshot vs. draft ignoring revision to detect real changes,
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
    if (from === to) {
      throwV2("SELF_EDGE", `addEdge: edge ${from} -> ${to} is a self-edge`, { from, to, type });
    }
    if (!EDGE_TYPES.includes(type)) {
      throwV2(
        "INVALID_EDGE_TYPE",
        `addEdge: edge type '${type}' is not allowed`,
        { type, allowed: [...EDGE_TYPES] },
      );
    }
    const fromNode = resolveEdgeNode(from);
    const toNode = resolveEdgeNode(to);
    if (!fromNode || !toNode) {
      const missing = !fromNode ? from : to;
      throwV2(
        "INVALID_EDGE_TARGET",
        `addEdge: edge ${type} ${from} -> ${to} references missing node '${missing}'`,
        { from, to, type, missing },
      );
    }
    // Structural kind checks (same shape as v2.mjs#validateEdge; the kernel
    // owns these so providers cannot slip past validation by going through
    // tx.addEdge).
    if (type === "BLOCKS") {
      if (fromNode.kind !== "resolvable" || toNode.kind !== "resolvable") {
        throwV2(
          "INVALID_EDGE_KIND",
          `addEdge: BLOCKS requires both ends to be resolvable (got ${fromNode.kind} -> ${toNode.kind})`,
          { from, to, type, fromKind: fromNode.kind, toKind: toNode.kind },
        );
      }
    } else if (type === "SUPERSEDES") {
      if (fromNode.kind !== toNode.kind) {
        throwV2(
          "INVALID_EDGE_KIND",
          `addEdge: SUPERSEDES requires both ends to be the same kind (got ${fromNode.kind} -> ${toNode.kind})`,
          { from, to, type, fromKind: fromNode.kind, toKind: toNode.kind },
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

  function view() {
    // Deep-clone the nodes and edges so the caller cannot mutate the draft
    // through the returned view. O(n) per call is acceptable: the draft is
    // B1a pure and callers are expected to call view() once at apply time.
    const nodes = {};
    for (const [id, node] of Object.entries(draftNodes)) {
      nodes[id] = clone(node);
    }
    return {
      nodes,
      edges: draftEdges.map((edge) => clone(edge)),
    };
  }

  return {
    getNode,
    createNode,
    updateNode,
    addEdge,
    removeEdge,
    view,
  };
}

// Export the local edge-types whitelist so future kernel slices (B1b) can
// reuse the same source of truth without going through v2.mjs.
export { EDGE_TYPES };
