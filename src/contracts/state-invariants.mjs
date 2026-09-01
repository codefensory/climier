// Pure state and edge invariants shared by storage, drafts, and restore.
// This module deliberately has no filesystem or adapter dependencies.

import { throwV2 } from "./errors.mjs";

export const EDGE_TYPES = Object.freeze(["BLOCKS", "SUPERSEDES", "DERIVED_FROM"]);

function nodesOf(state) {
  return state && state.nodes && typeof state.nodes === "object" && !Array.isArray(state.nodes)
    ? state.nodes
    : null;
}

function edgesOf(state) {
  return Array.isArray(state && state.edges) ? state.edges : null;
}

function edgeKey(edge) {
  return `${edge.from}|${edge.to}|${edge.type}`;
}

function validateEdgeShape(state, edge, commandName) {
  if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
    throwV2("INVALID_EDGE_TARGET", `${commandName}: edge must be an object`, { edge });
  }
  const { from, to, type } = edge;
  if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
    throwV2("INVALID_EDGE_TARGET", `${commandName}: edge endpoints must be non-empty strings`, { edge });
  }
  if (typeof type !== "string" || type.length === 0) {
    throwV2("INVALID_EDGE_TYPE", `${commandName}: edge type must be a non-empty string`, { edge });
  }
  return { from, to, type };
}

/** Validate one edge against the supplied node collection. */
export function validateEdge(state, edge, commandName = "state") {
  const { from, to, type } = validateEdgeShape(state, edge, commandName);
  if (from === to) {
    throwV2("SELF_EDGE", `${commandName}: edge ${from} -> ${to} is a self-edge`, { from, to, type });
  }
  const nodes = nodesOf(state) || {};
  const fromNode = nodes[from];
  const toNode = nodes[to];
  if (!fromNode || !toNode) {
    const missing = !fromNode ? from : to;
    throwV2(
      "INVALID_EDGE_TARGET",
      `${commandName}: edge ${type} ${from} -> ${to} references missing node '${missing}'`,
      { from, to, type, missing },
    );
  }
  if (!EDGE_TYPES.includes(type)) {
    throwV2(
      "INVALID_EDGE_TYPE",
      `${commandName}: edge type ${type} is not allowed (allowed: ${EDGE_TYPES.join(", ")})`,
      { type, allowed: [...EDGE_TYPES] },
    );
  }
  if (type === "BLOCKS" && (fromNode.kind !== "resolvable" || toNode.kind !== "resolvable")) {
    throwV2(
      "INVALID_EDGE_KIND",
      `${commandName}: BLOCKS requires both ends to be resolvable (got ${fromNode.kind} -> ${toNode.kind})`,
      { from, to, type, fromKind: fromNode.kind, toKind: toNode.kind },
    );
  }
  if (type === "SUPERSEDES" && fromNode.kind !== toNode.kind) {
    throwV2(
      "INVALID_EDGE_KIND",
      `${commandName}: SUPERSEDES requires both ends to be the same kind (got ${fromNode.kind} -> ${toNode.kind})`,
      { from, to, type, fromKind: fromNode.kind, toKind: toNode.kind },
    );
  }
  return { from, to, type };
}

function blocksAdjacency(state, extraEdge) {
  const adjacency = new Map();
  for (const edge of edgesOf(state) || []) {
    if (edge && edge.type === "BLOCKS" && typeof edge.from === "string" && typeof edge.to === "string") {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      adjacency.get(edge.from).push(edge.to);
    }
  }
  if (extraEdge && extraEdge.type === "BLOCKS") {
    if (!adjacency.has(extraEdge.from)) adjacency.set(extraEdge.from, []);
    adjacency.get(extraEdge.from).push(extraEdge.to);
  }
  return adjacency;
}

function pathBetween(adjacency, start, target) {
  const visited = new Set();
  const path = [];
  function visit(node) {
    if (visited.has(node)) return null;
    visited.add(node);
    path.push(node);
    if (node === target) return [...path];
    for (const next of adjacency.get(node) || []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    return null;
  }
  return visit(start);
}

/**
 * Return true when adding a BLOCKS edge would make the graph cyclic.
 * Accepts either (state, { from, to, type }) or (state, from, to).
 */
export function blocksCyclePath(state, edgeOrFrom, maybeTo) {
  const edge = typeof edgeOrFrom === "object"
    ? edgeOrFrom
    : { from: edgeOrFrom, to: maybeTo, type: "BLOCKS" };
  if (!edge || edge.type !== "BLOCKS") return null;
  if (edge.from === edge.to) return [edge.from, edge.to];
  const adjacency = blocksAdjacency(state);
  const returnPath = pathBetween(adjacency, edge.to, edge.from);
  return returnPath ? [edge.from, ...returnPath] : null;
}

export function wouldCreateBlocksCycle(state, edgeOrFrom, maybeTo) {
  return blocksCyclePath(state, edgeOrFrom, maybeTo) !== null;
}

function cycleInBlocks(state) {
  const adjacency = blocksAdjacency(state);
  const nodes = [...new Set((edgesOf(state) || []).flatMap((edge) => edge && edge.type === "BLOCKS" ? [edge.from, edge.to] : []))];
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  function visit(node) {
    if (visiting.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (visited.has(node)) return null;
    visiting.add(node);
    path.push(node);
    for (const next of adjacency.get(node) || []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }
  for (const node of nodes) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/** Validate all persisted state/draft structural invariants. */
export function validateStateInvariants(state, commandName = "state", options = {}) {
  const nodes = nodesOf(state);
  const edges = edgesOf(state);
  if (!nodes) throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state missing nodes collection`, { field: "nodes" });
  if (!edges) throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state missing edges collection`, { field: "edges" });
  if (options.requireCollections !== false) {
    if (!state.initiatives || typeof state.initiatives !== "object" || Array.isArray(state.initiatives)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state missing initiatives collection`, { field: "initiatives" });
    }
    if (!Array.isArray(state.log)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state missing log collection`, { field: "log" });
    }
  }
  if (options.requireRevision !== false && (!Number.isInteger(state.revision) || state.revision < 0)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state revision must be a non-negative integer`, { field: "revision", value: state.revision });
  }
  const seen = new Set();
  for (const edge of edges) {
    const normalized = validateEdge({ nodes }, edge, commandName);
    const key = edgeKey(normalized);
    if (seen.has(key)) {
      throwV2("DUPLICATE_EDGE", `${commandName}: edge ${normalized.type} ${normalized.from} -> ${normalized.to} is duplicated`, {
        ...normalized,
      });
    }
    seen.add(key);
  }
  const cycle = cycleInBlocks({ edges });
  if (cycle) {
    const from = cycle[0];
    const to = cycle[1];
    throwV2("CYCLE_DETECTED", `${commandName}: BLOCKS cycle detected`, {
      from,
      to,
      type: "BLOCKS",
      cycle,
    });
  }
  return state;
}

export { edgeKey };
