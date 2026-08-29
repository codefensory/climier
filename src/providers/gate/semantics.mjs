// src/providers/gate/semantics.mjs — canonical gate graph semantics.
//
// This module owns the pure rules shared by gate providers and projections:
// supersedence, currentness, satisfaction, readiness effects, and the inline
// gate projection. It deliberately has no filesystem, transaction, policy,
// command, registry, adapter, or CLI dependencies.

import { incoming } from "../../kernel/graph.mjs";

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

/**
 * Return the deterministic superseding gate for `id`.
 *
 * SUPERSEDES edges point from the newer gate to the older one, so a
 * superseder is an incoming edge to the node being queried. Existing data
 * may contain more than one such edge; choosing the lexical first keeps
 * projections and satisfaction deterministic while preserving the v2 rule.
 */
export function supersededBy(state, id) {
  const next = incoming({ edges: edgesOf(state) }, id, "SUPERSEDES")
    .map((edge) => edge.from)
    .filter((candidate) => typeof candidate === "string")
    .sort();
  return next[0] || null;
}

/** Whether a node has no superseding node in the graph. */
export function isCurrent(state, id) {
  return supersededBy(state, id) === null;
}

/**
 * Determine whether a graph node satisfies a BLOCKS dependency.
 * Superseded gates satisfy through their superseding chain. Cycles are
 * treated as unsatisfied rather than recursing forever.
 */
export function isSatisfied(state, id, seen) {
  const nodes = nodesOf(state);
  const node = nodes[id];
  if (!node || node.kind === "knowledge") return false;

  const visited = seen || new Set();
  if (visited.has(id)) return false;

  const status = node.status || "open";
  if (node.subkind === "task") return TERMINAL_TASK_STATUSES.has(status);
  if (node.subkind !== "gate") return false;
  if (status === "resolved") return true;
  if (status !== "superseded") return false;

  visited.add(id);
  const nextId = supersededBy(state, id);
  return nextId ? isSatisfied(state, nextId, visited) : false;
}

/** Same satisfaction rule when callers already hold the graph pair. */
export function isSatisfiedByGraph(nodes, edges, id, seen) {
  return isSatisfied({ nodes, edges }, id, seen);
}

function incomingBlockers(edges, id) {
  return edges.filter((edge) => edge && edge.type === "BLOCKS" && edge.to === id);
}

/** Pure readiness check matching the v2 task derivation. */
export function taskIsReadyByGraph(nodes, edges, id) {
  const node = nodes && nodes[id];
  if (!node || node.kind !== "resolvable" || node.subkind !== "task") return false;
  const status = node.status || "open";
  if (OUT_OF_READY_POOL_STATUSES.has(status) || node.backlog === true) return false;
  return incomingBlockers(Array.isArray(edges) ? edges : [], id)
    .every((edge) => isSatisfiedByGraph(nodes, edges, edge.from));
}

/**
 * Return task ids whose readiness flips when a gate changes between two
 * graph views. `up` reports newly ready tasks; `down` reports newly blocked
 * tasks. The result is sorted for stable provider effects.
 */
export function diffReadyByGate(snapshotGraph, viewGraph, gateId, direction) {
  const before = snapshotGraph && typeof snapshotGraph === "object" ? snapshotGraph : {};
  const after = viewGraph && typeof viewGraph === "object" ? viewGraph : {};
  const snapshotNodes = before.nodes && typeof before.nodes === "object" ? before.nodes : {};
  const snapshotEdges = Array.isArray(before.edges) ? before.edges : [];
  const viewNodes = after.nodes && typeof after.nodes === "object" ? after.nodes : {};
  const viewEdges = Array.isArray(after.edges) ? after.edges : [];
  const up = direction === "up";
  const result = [];

  for (const [taskId, node] of Object.entries(viewNodes)) {
    if (!node || node.kind !== "resolvable" || node.subkind !== "task") continue;
    const status = node.status || "open";
    if (OUT_OF_READY_POOL_STATUSES.has(status) || node.backlog === true) continue;
    const dependsOnGate = viewEdges.some(
      (edge) => edge && edge.type === "BLOCKS" && edge.from === gateId && edge.to === taskId,
    );
    if (!dependsOnGate) continue;

    const wasReady = taskIsReadyByGraph(snapshotNodes, snapshotEdges, taskId);
    const isReady = taskIsReadyByGraph(viewNodes, viewEdges, taskId);
    if ((up && !wasReady && isReady) || (!up && wasReady && !isReady)) result.push(taskId);
  }
  return result.sort();
}

/**
 * Add the canonical currentness fields to a gate projection. Missing nodes
 * use the same compatibility shape as the v2 inline projection.
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

// Descriptive alias for consumers that prefer the noun-first name.
export const projectGate = gateProjection;
