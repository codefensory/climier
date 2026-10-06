// Pure state and edge invariants shared by storage, drafts, and restore.
// This module deliberately has no filesystem or adapter dependencies.

import { throwV2 } from "./errors.ts";
import type { CoreErrorCode, ErrorDetails } from "./errors.ts";
import type { Edge, EdgeType, Node } from "./domain.ts";

export const EDGE_TYPES = Object.freeze(["BLOCKS", "SUPERSEDES", "DERIVED_FROM"] as const);

type StateLike = {
  nodes?: Record<string, NodeLike>;
  edges?: unknown;
  initiatives?: unknown;
  log?: unknown;
  revision?: unknown;
};

type NodeLike = Pick<Node, "kind"> & Record<string, unknown>;
type EdgeLike = { from?: unknown; to?: unknown; type?: unknown };
type Adjacency = Map<string, string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nodesOf(state: unknown): Record<string, NodeLike> | null {
  if (!isRecord(state) || !isRecord(state.nodes)) { return null; }
  return state.nodes as Record<string, NodeLike>;
}

function edgesOf(state: unknown): unknown[] | null {
  return isRecord(state) && Array.isArray(state.edges) ? state.edges : null;
}

function edgeKey(edge: EdgeLike): string {
  return `${String(edge.from)}|${String(edge.to)}|${String(edge.type)}`;
}

function invalidEdge(commandName: string, message: string, code: CoreErrorCode, details: ErrorDetails): never {
  throwV2(code, `${commandName}: ${message}`, details);
}

function assertEdgeObject(edge: unknown, commandName: string): asserts edge is EdgeLike {
  if (!isRecord(edge)) {
    invalidEdge(commandName, "edge must be an object", "INVALID_EDGE_TARGET", { edge });
  }
}

function validateEdgeEndpoints(edge: EdgeLike, commandName: string): asserts edge is EdgeLike & { from: string; to: string } {
  const { from, to } = edge;
  if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
    invalidEdge(commandName, "edge endpoints must be non-empty strings", "INVALID_EDGE_TARGET", { edge });
  }
}

function validateEdgeType(type: unknown, edge: EdgeLike, commandName: string): asserts type is string {
  if (typeof type !== "string" || type.length === 0) {
    invalidEdge(commandName, "edge type must be a non-empty string", "INVALID_EDGE_TYPE", { edge });
  }
}

function validateEdgeShape(edge: unknown, commandName: string): EdgeLike & { from: string; to: string; type: string } {
  assertEdgeObject(edge, commandName);
  const { from, to, type } = edge;
  validateEdgeEndpoints(edge, commandName);
  validateEdgeType(type, edge, commandName);
  return { from: from as string, to: to as string, type: type as string };
}

function kindRule(type: string): { valid: (fromNode: NodeLike, toNode: NodeLike) => boolean; message: string } | null {
  if (type === "BLOCKS") { return { valid: (fromNode, toNode) => fromNode.kind === "resolvable" && toNode.kind === "resolvable", message: "BLOCKS requires both ends to be resolvable" }; }
  if (type === "SUPERSEDES") { return { valid: (fromNode, toNode) => fromNode.kind === toNode.kind, message: "SUPERSEDES requires both ends to be the same kind" }; }
  return null;
}

function validateEdgeKinds(nodes: Record<string, NodeLike>, edge: EdgeLike & { from: string; to: string; type: string }, commandName: string): void {
  const { from, to, type } = edge;
  const rule = kindRule(type);
  if (!rule) { return; }
  const fromNode = nodes[from];
  const toNode = nodes[to];
  if (!fromNode || !toNode) { return; }
  if (!rule.valid(fromNode, toNode)) {
    invalidEdge(commandName, `${rule.message} (got ${fromNode.kind} -> ${toNode.kind})`, "INVALID_EDGE_KIND", {
      from, to, type, fromKind: fromNode.kind, toKind: toNode.kind,
    });
  }
}

function isEdgeType(type: string): type is EdgeType {
  return (EDGE_TYPES as readonly string[]).includes(type);
}


export function validateEdge(state: unknown, edge: unknown, commandName = "state"): Edge {
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
  if (!isEdgeType(type)) {
    invalidEdge(commandName, `edge type ${type} is not allowed (allowed: ${EDGE_TYPES.join(", ")})`, "INVALID_EDGE_TYPE", { type, allowed: [...EDGE_TYPES] });
  }
  validateEdgeKinds(nodes, { from, to, type }, commandName);
  return { from, to, type };
}

function addAdjacency(adjacency: Adjacency, from: string, to: string): void {
  if (!adjacency.has(from)) { adjacency.set(from, []); }
  adjacency.get(from)?.push(to);
}

function isBlocksEdge(edge: unknown): edge is EdgeLike & { from: string; to: string; type: "BLOCKS" } {
  return isRecord(edge) && edge.type === "BLOCKS" && typeof edge.from === "string" && typeof edge.to === "string";
}

function blocksAdjacency(state: unknown, extraEdge?: unknown): Adjacency {
  const adjacency: Adjacency = new Map();
  for (const edge of edgesOf(state) || []) {
    if (isBlocksEdge(edge)) { addAdjacency(adjacency, edge.from, edge.to); }
  }
  if (isBlocksEdge(extraEdge)) { addAdjacency(adjacency, extraEdge.from, extraEdge.to); }
  return adjacency;
}

function pathBetween(adjacency: Adjacency, start: string, target: string): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];
  function visit(node: string): string[] | null {
    if (visited.has(node)) { return null; }
    visited.add(node);
    path.push(node);
    if (node === target) { return [...path]; }
    for (const next of adjacency.get(node) || []) {
      const found = visit(next);
      if (found) { return found; }
    }
    path.pop();
    return null;
  }
  return visit(start);
}


export function blocksCyclePath(state: unknown, edgeOrFrom: unknown, maybeTo?: unknown): string[] | null {
  const edge: EdgeLike = isRecord(edgeOrFrom)
    ? edgeOrFrom
    : { from: edgeOrFrom, to: maybeTo, type: "BLOCKS" };
  if (!isBlocksEdge(edge)) { return null; }
  if (edge.from === edge.to) { return [edge.from, edge.to]; }
  const returnPath = pathBetween(blocksAdjacency(state), edge.to, edge.from);
  return returnPath ? [edge.from, ...returnPath] : null;
}

export function wouldCreateBlocksCycle(state: unknown, edgeOrFrom: unknown, maybeTo?: unknown): boolean {
  return blocksCyclePath(state, edgeOrFrom, maybeTo) !== null;
}

function cycleInBlocks(state: unknown): string[] | null {
  const adjacency = blocksAdjacency(state);
  const nodes = [...new Set((edgesOf(state) || []).flatMap((edge) => isBlocksEdge(edge) ? [edge.from, edge.to] : []))];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  function visit(node: string): string[] | null {
    if (visiting.has(node)) { return [...path.slice(path.indexOf(node)), node]; }
    if (visited.has(node)) { return null; }
    visiting.add(node);
    path.push(node);
    for (const next of adjacency.get(node) || []) {
      const found = visit(next);
      if (found) { return found; }
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }
  for (const node of nodes) {
    const found = visit(node);
    if (found) { return found; }
  }
  return null;
}

type ValidationOptions = { requireCollections?: boolean; requireRevision?: boolean };

function requireCollection(field: string, commandName: string, valid: boolean): void {
  if (!valid) { throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state missing ${field} collection`, { field }); }
}

function validateRequiredCollections(state: StateLike, commandName: string, options: ValidationOptions): void {
  if (options.requireCollections === false) { return; }
  requireCollection("initiatives", commandName, isRecord(state.initiatives));
  requireCollection("log", commandName, Array.isArray(state.log));
}

function validateRevision(state: StateLike, commandName: string, options: ValidationOptions): void {
  if (options.requireRevision !== false && (!Number.isInteger(state.revision) || (state.revision as number) < 0)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state revision must be a non-negative integer`, { field: "revision", value: state.revision });
  }
}

function validateStateCollections(state: unknown, commandName: string, options: ValidationOptions): void {
  const stateLike = isRecord(state) ? state as StateLike : {};
  requireCollection("nodes", commandName, Boolean(nodesOf(state)));
  requireCollection("edges", commandName, Boolean(edgesOf(state)));
  validateRequiredCollections(stateLike, commandName, options);
  validateRevision(stateLike, commandName, options);
}

function validateUniqueEdges(nodes: Record<string, NodeLike> | null, edges: unknown[], commandName: string): void {
  const seen = new Set<string>();
  for (const edge of edges) {
    const normalized = validateEdge({ nodes: nodes || {} }, edge, commandName);
    const key = edgeKey(normalized);
    if (seen.has(key)) {
      throwV2("DUPLICATE_EDGE", `${commandName}: edge ${normalized.type} ${normalized.from} -> ${normalized.to} is duplicated`, { ...normalized });
    }
    seen.add(key);
  }
}

/** Validate all persisted state/draft structural invariants. */
export function validateStateInvariants(state: unknown, commandName = "state", options: ValidationOptions = {}): unknown {
  validateStateCollections(state, commandName, options);
  const nodes = nodesOf(state);
  const edges = edgesOf(state) || [];
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
