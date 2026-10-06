// src/providers/gate/semantics.ts — canonical gate graph semantics.
// This module owns the pure rules shared by gate providers and projections:
// supersedence, currentness, satisfaction, readiness effects, and the inline
// gate projection. It deliberately has no filesystem, transaction, policy,
// command, registry, adapter, or CLI dependencies.

import { incoming } from "../../kernel/graph.ts";

const TERMINAL_TASK_STATUSES = new Set(["done", "archived"]);
const OUT_OF_READY_POOL_STATUSES = new Set(["in_progress", "done", "archived", "canceled"]);

function nodesOf(state) {
  return state && state.nodes && typeof state.nodes === "object" && !Array.isArray(state.nodes)
    ? state.nodes
    : {};
}

function edgesOf(state) {
  return Array.isArray(state && state.edges) ? state.edges : [];
}


export function supersededBy(state, id) {
  const next = incoming({ edges: edgesOf(state) }, id, "SUPERSEDES")
    .map((edge) => edge.from)
    .filter((candidate) => typeof candidate === "string")
    .toSorted();
  return next[0] || null;
}


export function isCurrent(state, id) {
  return supersededBy(state, id) === null;
}

/**
 * Determine whether a graph node satisfies a BLOCKS dependency.
 * Superseded gates satisfy through their superseding chain. Cycles are
 * treated as unsatisfied rather than recursing forever.
 */
export function isSatisfied(state, id, seen) {
  return satisfyNode(state, nodesOf(state)[id], id, seen || new Set());
}

function satisfyNode(state, node, id, visited) {
  if (!node || node.kind === "knowledge") {
    return false;
  }

  if (visited.has(id)) {
    return false;
  }

  const status = node.status || "open";
  if (node.subkind === "task") {
    return TERMINAL_TASK_STATUSES.has(status);
  }
  if (node.subkind === "gate") {
    return satisfyGate(state, id, status, visited);
  }
  return false;
}

function satisfyGate(state, id, status, visited) {
  if (status === "resolved") {
    return true;
  }
  if (status !== "superseded") {
    return false;
  }
  visited.add(id);
  const nextId = supersededBy(state, id);
  return nextId ? satisfyNode(state, nodesOf(state)[nextId], nextId, visited) : false;
}


export function isSatisfiedByGraph(nodes, edges, id, seen?) {
  return isSatisfied({ nodes, edges }, id, seen);
}

function incomingBlockers(edges, id) {
  return edges.filter((edge) => edge && edge.type === "BLOCKS" && edge.to === id);
}


export function taskIsReadyByGraph(nodes, edges, id) {
  const node = nodes && nodes[id];
  if (!isReadyTaskCandidate(node) || !isInReadyPool(node, node.status || "open")) {
    return false;
  }
  return incomingBlockers(Array.isArray(edges) ? edges : [], id)
    .every((edge) => isSatisfiedByGraph(nodes, edges, edge.from));
}


export function diffReadyByGate(snapshotGraph, viewGraph, gateId, direction) {
  const before = normalizeGraph(snapshotGraph);
  const after = normalizeGraph(viewGraph);
  return Object.entries(after.nodes)
    .filter(([taskId, node]) => isAffectedTask(node, after.edges, gateId, taskId))
    .filter(([taskId]) => didReadinessFlip(before, after, taskId, direction === "up"))
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

function isAffectedTask(node, edges, gateId, taskId) {
  if (!isReadyTaskCandidate(node)) {
    return false;
  }
  return isInReadyPool(node, node.status || "open") && dependsOnGate(edges, gateId, taskId);
}

function didReadinessFlip(before, after, taskId, up) {
  const wasReady = taskIsReadyByGraph(before.nodes, before.edges, taskId);
  const isReady = taskIsReadyByGraph(after.nodes, after.edges, taskId);
  return readinessChanged(up, wasReady, isReady);
}

function isReadyTaskCandidate(node) {
  return node && node.kind === "resolvable" && node.subkind === "task";
}

function isInReadyPool(node, status) {
  return !OUT_OF_READY_POOL_STATUSES.has(status) && node.backlog !== true;
}

function dependsOnGate(edges, gateId, taskId) {
  return edges.some((edge) => edge && edge.type === "BLOCKS" && edge.from === gateId && edge.to === taskId);
}

function readinessChanged(up, wasReady, isReady) {
  return up ? !wasReady && isReady : wasReady && !isReady;
}

/**
 * Add the canonical currentness fields to a gate projection. Missing nodes
 */
export function gateProjection(state, id) {
  const node = nodesOf(state)[id];
  if (!node) {
    return { id, status: "missing", is_current: true, superseded_by: null };
  }
  const supersededById = supersededBy(state, id);
  return {
    ...node,
    is_current: supersededById === null,
    superseded_by: supersededById,
  };
}


export const projectGate = gateProjection;
