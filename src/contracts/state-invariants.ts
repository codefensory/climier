// Pure state and edge invariants shared by storage, drafts, and restore.
// This module deliberately has no filesystem or adapter dependencies.

import { throwV2 } from "./errors.ts";

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

function invalidEdge(commandName, message, code, details) {
  throwV2(code, `${commandName}: ${message}`, details);
}

function assertEdgeObject(edge, commandName) {
  if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
    invalidEdge(commandName, "edge must be an object", "INVALID_EDGE_TARGET", { edge });
  }
}

function validateEdgeEndpoints(edge, commandName) {
  const { from, to } = edge;
  if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
    invalidEdge(commandName, "edge endpoints must be non-empty strings", "INVALID_EDGE_TARGET", { edge });
  }
}

function validateEdgeType(type, edge, commandName) {
  if (typeof type !== "string" || type.length === 0) {
    invalidEdge(commandName, "edge type must be a non-empty string", "INVALID_EDGE_TYPE", { edge });
  }
}

function validateEdgeShape(edge, commandName) {
  assertEdgeObject(edge, commandName);
  const { from, to, type } = edge;
  validateEdgeEndpoints(edge, commandName);
  validateEdgeType(type, edge, commandName);
  return { from, to, type };
}

function kindRule(type) {
  if (type === "BLOCKS") {return { valid: (fromNode, toNode) => fromNode.kind === "resolvable" && toNode.kind === "resolvable", message: "BLOCKS requires both ends to be resolvable" };}
  if (type === "SUPERSEDES") {return { valid: (fromNode, toNode) => fromNode.kind === toNode.kind, message: "SUPERSEDES requires both ends to be the same kind" };}
  return null;
}

function validateEdgeKinds(nodes, edge, commandName) {
  const { from, to, type } = edge;
  const rule = kindRule(type);
  if (!rule) {return;}
  const fromNode = nodes[from];
  const toNode = nodes[to];
  if (!rule.valid(fromNode, toNode)) {
    invalidEdge(commandName, `${rule.message} (got ${fromNode.kind} -> ${toNode.kind})`, "INVALID_EDGE_KIND", {
      from, to, type, fromKind: fromNode.kind, toKind: toNode.kind,
    });
  }
}


export function validateEdge(state, edge, commandName = "state") {
  const { from, to, type } = validateEdgeShape(edge, commandName);
  if (from === to) {
    invalidEdge(commandName, `edge ${from} -> ${to} is a self-edge`, "SELF_EDGE", { from, to, type });
  }
  const nodes = nodesOf(state) || {};
  const fromNode = nodes[from];
  const toNode = nodes[to];
  if (!fromNode || !toNode) {
    const missing = !fromNode ? from : to;
    invalidEdge(commandName, `edge ${type} ${from} -> ${to} references missing node '${missing}'`, "INVALID_EDGE_TARGET", { from, to, type, missing });
  }
  if (!EDGE_TYPES.includes(type)) {
    invalidEdge(commandName, `edge type ${type} is not allowed (allowed: ${EDGE_TYPES.join(", ")})`, "INVALID_EDGE_TYPE", { type, allowed: [...EDGE_TYPES] });
  }
  validateEdgeKinds(nodes, { from, to, type }, commandName);
  return { from, to, type };
}

function addAdjacency(adjacency, from, to) {
  if (!adjacency.has(from)) {adjacency.set(from, []);}
  adjacency.get(from).push(to);
}

function isBlocksEdge(edge) {
  return edge && edge.type === "BLOCKS" && typeof edge.from === "string" && typeof edge.to === "string";
}

function blocksAdjacency(state, extraEdge) {
  const adjacency = new Map();
  for (const edge of edgesOf(state) || []) {
    if (isBlocksEdge(edge)) {addAdjacency(adjacency, edge.from, edge.to);}
  }
  if (isBlocksEdge(extraEdge)) {addAdjacency(adjacency, extraEdge.from, extraEdge.to);}
  return adjacency;
}

function pathBetween(adjacency, start, target) {
  const visited = new Set();
  const path = [];
  function visit(node) {
    if (visited.has(node)) {return null;}
    visited.add(node);
    path.push(node);
    if (node === target) {return [...path];}
    for (const next of adjacency.get(node) || []) {
      const found = visit(next);
      if (found) {return found;}
    }
    path.pop();
    return null;
  }
  return visit(start);
}


export function blocksCyclePath(state, edgeOrFrom, maybeTo) {
  const edge = typeof edgeOrFrom === "object"
    ? edgeOrFrom
    : { from: edgeOrFrom, to: maybeTo, type: "BLOCKS" };
  if (!edge || edge.type !== "BLOCKS") {return null;}
  if (edge.from === edge.to) {return [edge.from, edge.to];}
  const returnPath = pathBetween(blocksAdjacency(state), edge.to, edge.from);
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
    if (visiting.has(node)) {return [...path.slice(path.indexOf(node)), node];}
    if (visited.has(node)) {return null;}
    visiting.add(node);
    path.push(node);
    for (const next of adjacency.get(node) || []) {
      const found = visit(next);
      if (found) {return found;}
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }
  for (const node of nodes) {
    const found = visit(node);
    if (found) {return found;}
  }
  return null;
}

function requireCollection(field, commandName, valid) {
  if (!valid) {throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state missing ${field} collection`, { field });}
}

function validateRequiredCollections(state, commandName, options) {
  if (options.requireCollections === false) {return;}
  requireCollection("initiatives", commandName, state.initiatives && typeof state.initiatives === "object" && !Array.isArray(state.initiatives));
  requireCollection("log", commandName, Array.isArray(state.log));
}

function validateRevision(state, commandName, options) {
  if (options.requireRevision !== false && (!Number.isInteger(state.revision) || state.revision < 0)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state revision must be a non-negative integer`, { field: "revision", value: state.revision });
  }
}

function validateStateCollections(state, commandName, options) {
  requireCollection("nodes", commandName, Boolean(nodesOf(state)));
  requireCollection("edges", commandName, Boolean(edgesOf(state)));
  validateRequiredCollections(state, commandName, options);
  validateRevision(state, commandName, options);
}

function validateUniqueEdges(nodes, edges, commandName) {
  const seen = new Set();
  for (const edge of edges) {
    const normalized = validateEdge({ nodes }, edge, commandName);
    const key = edgeKey(normalized);
    if (seen.has(key)) {
      throwV2("DUPLICATE_EDGE", `${commandName}: edge ${normalized.type} ${normalized.from} -> ${normalized.to} is duplicated`, { ...normalized });
    }
    seen.add(key);
  }
}

/** Validate all persisted state/draft structural invariants. */
export function validateStateInvariants(state, commandName = "state", options = {}) {
  validateStateCollections(state, commandName, options);
  const nodes = nodesOf(state);
  const edges = edgesOf(state);
  validateUniqueEdges(nodes, edges, commandName);
  const cycle = cycleInBlocks({ edges });
  if (cycle) {
    throwV2("CYCLE_DETECTED", `${commandName}: BLOCKS cycle detected`, {
      from: cycle[0], to: cycle[1], type: "BLOCKS", cycle,
    });
  }
  return state;
}

export { edgeKey };
