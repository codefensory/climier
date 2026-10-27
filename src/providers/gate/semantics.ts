// src/providers/gate/semantics.ts — canonical gate graph semantics.
// This module owns the pure rules shared by gate providers and projections:
// supersedence, currentness, satisfaction, readiness effects, and the inline
// gate projection. It deliberately has no filesystem, transaction, policy,
// command, registry, adapter, or CLI dependencies.

import { createGraphProjection, incoming, type GraphProjection } from "../../kernel/graph.ts";

const TERMINAL_TASK_STATUSES = new Set(["done", "archived"]);
const OUT_OF_READY_POOL_STATUSES = new Set(["in_progress", "done", "archived", "canceled"]);

function nodesOf(state) {
  return state && state.nodes && typeof state.nodes === "object" && !Array.isArray(state.nodes)
    ? state.nodes
    : {};
}

export function supersededBy(state, id, graph?: GraphProjection) {
  const next = incoming(state, id, "SUPERSEDES", graph?.indexes)
    .map((edge) => edge.from)
    .filter((candidate) => typeof candidate === "string")
    .toSorted();
  return next[0] || null;
}


export function isCurrent(state, id, graph?: GraphProjection) {
  return supersededBy(state, id, graph) === null;
}

/**
 * Determine whether a graph node satisfies a BLOCKS dependency.
 * Superseded gates satisfy through their superseding chain. Cycles are
 * treated as unsatisfied rather than recursing forever.
 */
interface SatisfactionContext {
  graph?: GraphProjection;
  memo: Map<string, boolean>;
  visited: Set<string>;
}

function satisfactionContext(seenOrGraph?: Set<string> | GraphProjection): SatisfactionContext {
  if (seenOrGraph instanceof Set) {
    return { memo: new Map(), visited: seenOrGraph };
  }
  return {
    graph: seenOrGraph,
    memo: seenOrGraph?.satisfactionMemo || new Map(),
    visited: new Set(),
  };
}

export function isSatisfied(state, id, seenOrGraph?: Set<string> | GraphProjection) {
  return satisfyNode(state, nodesOf(state)[id], id, satisfactionContext(seenOrGraph));
}

function satisfyNode(state, node, id, context: SatisfactionContext) {
  if (!node || node.kind === "knowledge") {
    return false;
  }
  if (context.visited.has(id)) {
    return false;
  }
  if (context.memo.has(id)) {
    return context.memo.get(id)!;
  }
  const status = node.status || "open";
  let satisfied = false;
  if (node.subkind === "task") {
    satisfied = TERMINAL_TASK_STATUSES.has(status);
  } else if (node.subkind === "gate") {
    satisfied = satisfyGate(state, id, status, context);
  }
  context.memo.set(id, satisfied);
  return satisfied;
}

function satisfyGate(state, id, status, context: SatisfactionContext) {
  if (status === "resolved") {
    return true;
  }
  if (status !== "superseded") {
    return false;
  }
  context.visited.add(id);
  const nextId = supersededBy(state, id, context.graph);
  return nextId ? satisfyNode(state, nodesOf(state)[nextId], nextId, context) : false;
}


export function isSatisfiedByGraph(nodes, edges, id, seenOrGraph?: Set<string> | GraphProjection) {
  return isSatisfied({ nodes, edges }, id, seenOrGraph);
}

export function taskIsReadyByGraph(nodes, edges, id, graph?: GraphProjection) {
  const node = nodes && nodes[id];
  if (!isReadyTaskCandidate(node) || !isInReadyPool(node, node.status || "open")) {
    return false;
  }
  const snapshot = { nodes, edges };
  const currentGraph = graph || createGraphProjection(snapshot);
  return incoming(snapshot, id, "BLOCKS", currentGraph.indexes)
    .every((edge) => isSatisfiedByGraph(nodes, edges, edge.from, currentGraph));
}


export function diffReadyByGate(snapshotGraph, viewGraph, gateId, direction) {
  const before = normalizeGraph(snapshotGraph);
  const after = normalizeGraph(viewGraph);
  const beforeGraph = createGraphProjection(before);
  const afterGraph = createGraphProjection(after);
  return Object.entries(after.nodes)
    .filter(([taskId, node]) => isAffectedTask(node, { snapshot: after, graph: afterGraph, gateId, taskId }))
    .filter(([taskId]) => didReadinessFlip({ before, after, taskId, up: direction === "up", beforeGraph, afterGraph }))
    .map(([taskId]) => taskId)
    .toSorted();
}

function normalizeGraph(graph) {
  const source = graph && typeof graph === "object" ? graph : {};
  return {
    nodes: source.nodes && typeof source.nodes === "object" ? source.nodes : {},
    edges: Array.isArray(source.edges) ? source.edges : [],
  };
}

function isAffectedTask(node, { snapshot, graph, gateId, taskId }) {
  if (!isReadyTaskCandidate(node)) {
    return false;
  }
  return isInReadyPool(node, node.status || "open") && dependsOnGate({ snapshot, graph, gateId, taskId });
}

function didReadinessFlip({ before, after, taskId, up, beforeGraph, afterGraph }) {
  const wasReady = taskIsReadyByGraph(before.nodes, before.edges, taskId, beforeGraph);
  const isReady = taskIsReadyByGraph(after.nodes, after.edges, taskId, afterGraph);
  return readinessChanged(up, wasReady, isReady);
}

function isReadyTaskCandidate(node) {
  return node && node.kind === "resolvable" && node.subkind === "task";
}

function isInReadyPool(node, status) {
  return !OUT_OF_READY_POOL_STATUSES.has(status) && node.backlog !== true;
}

function dependsOnGate({ snapshot, graph, gateId, taskId }) {
  return incoming(snapshot, taskId, "BLOCKS", graph.indexes).some((edge) => edge.from === gateId);
}

function readinessChanged(up, wasReady, isReady) {
  return up ? !wasReady && isReady : wasReady && !isReady;
}

/**
 * Add the canonical currentness fields to a gate projection. Missing nodes
 */
export function gateProjection(state, id, graph?: GraphProjection) {
  const node = nodesOf(state)[id];
  if (!node) {
    return { id, status: "missing", is_current: true, superseded_by: null };
  }
  const supersededById = supersededBy(state, id, graph);
  return {
    ...node,
    is_current: supersededById === null,
    superseded_by: supersededById,
  };
}


export const projectGate = gateProjection;
