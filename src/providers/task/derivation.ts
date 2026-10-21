

// are pure provider semantics. This module deliberately has no filesystem,
// transaction, lock, persistence, log, command, registry or adapter imports.


import { incoming, type GraphProjection } from "../../kernel/graph.ts";

const NON_OPEN_TASK_STATUSES = new Set(["in_progress", "submitted", "done", "archived", "canceled"]);
const SATISFIED_TASK_STATUSES = new Set(["done", "archived"]);
type TaskNode = Record<string, unknown> & {
  kind?: string;
  subkind?: string;
  status?: string;
  backlog?: boolean;
};

function nodesOf(state): Record<string, TaskNode> {
  return state && state.nodes && typeof state.nodes === "object" ? state.nodes : {};
}


export function supersededBy(state, id, graph?: GraphProjection) {
  return incoming(state, id, "SUPERSEDES", graph?.indexes)
    .map((edge) => edge.from)
    .toSorted()[0] || null;
}

function satisfyReplacement({ state, id }, visiting, graph?: GraphProjection) {
  const nextId = supersededBy(state, id, graph);
  if (!nextId) {
    return false;
  }
  visiting.add(id);
  const satisfied = satisfy(state, nextId, visiting, graph);
  visiting.delete(id);
  return satisfied;
}

function satisfyNode({ state, node, id }, visiting, graph?: GraphProjection) {
  const status = node.status || "open";
  if (node.subkind === "task") {
    return SATISFIED_TASK_STATUSES.has(status) ||
      (status === "canceled" && satisfyReplacement({ state, id }, visiting, graph));
  }
  if (node.subkind === "gate") {
    return status === "resolved" ||
      (status === "superseded" && satisfyReplacement({ state, id }, visiting, graph));
  }
  return false;
}

function isUnknownOrKnowledge(node) {
  return !node || node.kind === "knowledge";
}

function rememberSatisfaction(graph: GraphProjection | undefined, id: string, satisfied: boolean) {
  graph?.satisfactionMemo.set(id, satisfied);
  return satisfied;
}

function satisfy(state, id, visiting, graph?: GraphProjection) {
  if (visiting.has(id)) {
    return false;
  }
  const memo = graph?.satisfactionMemo;
  if (memo?.has(id)) {
    return memo.get(id)!;
  }
  const node = nodesOf(state)[id];
  if (isUnknownOrKnowledge(node)) {
    return rememberSatisfaction(graph, id, false);
  }
  return rememberSatisfaction(graph, id, satisfyNode({ state, node, id }, visiting, graph));
}

/**
 * Whether a node satisfies a BLOCKS dependency.
 *
 * Unknown nodes and knowledge nodes are intentionally unsatisfied. Superseded
 * gates and canceled tasks with replacements follow their chains, with cycle
 * protection so malformed graphs remain blocked instead of overflowing.
 */
export function isSatisfiedV2(state, id, seen = new Set(), graph?: GraphProjection) {
  const currentGraph = seen.size === 0 || !graph ? graph : { ...graph, satisfactionMemo: new Map() };
  return satisfy(state, id, new Set(seen), currentGraph);
}

/**
 *
 * An unknown blocker is unsatisfied by design. Cycles of open tasks therefore
 * remain blocked without requiring a separate topological traversal.
 */
export function isTaskReady(state, id, graph?: GraphProjection) {
  const node = nodesOf(state)[id];
  if (!node || node.kind !== "resolvable" || node.subkind !== "task") {
    return false;
  }
  const status = node.status || "open";
  if (NON_OPEN_TASK_STATUSES.has(status) || node.backlog === true) {
    return false;
  }
  return incoming(state, id, "BLOCKS", graph?.indexes)
    .every((edge) => isSatisfiedV2(state, edge.from, undefined, graph));
}

// Short aliases make the provider's domain vocabulary usable without tying


export const isReady = isTaskReady;
export const readiness = isTaskReady;


export function collectReadyTasks(state, graph?: GraphProjection) {
  const ready: string[] = [];
  for (const [id, node] of Object.entries(nodesOf(state))) {
    if (node && node.kind === "resolvable" && node.subkind === "task" && isTaskReady(state, id, graph)) {
      ready.push(id);
    }
  }
  return ready;
}

function collectOpenGate(id, node, status, openGates) {
  if (node.subkind === "gate" && status === "open") {
    openGates.push(id);
  }
}

function collectTaskStatus(state, task, pools, graph?: GraphProjection) {
  const { id, node, status } = task;
  if (node.subkind === "gate" || NON_OPEN_TASK_STATUSES.has(status)) {
    return;
  }
  if (node.backlog === true) {
    pools.backlog.push(id);
    return;
  }
  if (isTaskReady(state, id, graph)) {
    pools.ready.push(id);
  } else {
    pools.blocked.push(id);
  }
}


export function deriveV2(state, graph?: GraphProjection) {
  const pools = { ready: [], blocked: [], backlog: [], openGates: [] };
  const nodes = nodesOf(state);
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || node.kind !== "resolvable") {
      continue;
    }
    const status = node.status || "open";
    collectOpenGate(id, node, status, pools.openGates);
    collectTaskStatus(state, { id, node, status }, pools, graph);
  }
  return pools;
}

function lifecycleStatus(node, status) {
  if (node.kind === "knowledge") {
    return node.status || "active";
  }
  if (["in_progress", "submitted", "done", "archived", "canceled", "resolved", "superseded"].includes(status)) {
    return status;
  }
  return null;
}


export function statusOfV2(state, id, graph?: GraphProjection) {
  const node = nodesOf(state)[id];
  if (!node) {
    return "unknown";
  }
  const status = node.status || "open";
  const lifecycle = lifecycleStatus(node, status);
  if (lifecycle) {
    return lifecycle;
  }
  if (node.backlog === true) {
    return "backlog";
  }
  return isTaskReady(state, id, graph) ? "ready" : "blocked";
}


export const isSatisfiedByGraph = isSatisfiedV2;
export const taskIsReadyByGraph = isTaskReady;
