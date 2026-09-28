

// are pure provider semantics. This module deliberately has no filesystem,
// transaction, lock, persistence, log, command, registry or adapter imports.


const NON_OPEN_TASK_STATUSES = new Set(["in_progress", "submitted", "done", "archived", "canceled"]);
const SATISFIED_TASK_STATUSES = new Set(["done", "archived"]);

function nodesOf(state) {
  return state && state.nodes && typeof state.nodes === "object" ? state.nodes : {};
}

function edgesOf(state) {
  return Array.isArray(state && state.edges) ? state.edges : [];
}


export function supersededBy(state, id) {
  return edgesOf(state)
    .filter((edge) => edge.type === "SUPERSEDES" && edge.to === id)
    .map((edge) => edge.from)
    .toSorted()[0] || null;
}

function isSatisfiedNode(node, state, id, seen) {
  if (node.subkind === "task") {
    const status = node.status || "open";
    if (SATISFIED_TASK_STATUSES.has(status)) {
      return true;
    }
    if (status !== "canceled") {
      return false;
    }
    const nextId = supersededBy(state, id);
    if (!nextId) {
      return false;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    return isSatisfiedV2(state, nextId, nextSeen);
  }
  if (node.subkind !== "gate") {
    return false;
  }
  const status = node.status || "open";
  if (status === "resolved") {
    return true;
  }
  if (status !== "superseded") {
    return false;
  }
  const nextId = supersededBy(state, id);
  if (!nextId) {
    return false;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(id);
  return isSatisfiedV2(state, nextId, nextSeen);
}

/**
 * Whether a node satisfies a BLOCKS dependency.
 *
 * Unknown nodes and knowledge nodes are intentionally unsatisfied. Superseded
 * gates and canceled tasks with replacements follow their chains, with cycle
 * protection so malformed graphs remain blocked instead of overflowing.
 */
export function isSatisfiedV2(state, id, seen = new Set()) {
  const node = nodesOf(state)[id];
  if (!node || node.kind === "knowledge" || seen.has(id)) {
    return false;
  }
  return isSatisfiedNode(node, state, id, seen);
}

/**
 *
 * An unknown blocker is unsatisfied by design. Cycles of open tasks therefore
 * remain blocked without requiring a separate topological traversal.
 */
export function isTaskReady(state, id) {
  const node = nodesOf(state)[id];
  if (!node || node.kind !== "resolvable" || node.subkind !== "task") {
    return false;
  }
  const status = node.status || "open";
  if (NON_OPEN_TASK_STATUSES.has(status) || node.backlog === true) {
    return false;
  }
  return edgesOf(state)
    .filter((edge) => edge.type === "BLOCKS" && edge.to === id)
    .every((edge) => isSatisfiedV2(state, edge.from));
}

// Short aliases make the provider's domain vocabulary usable without tying


export const isReady = isTaskReady;
export const readiness = isTaskReady;


export function collectReadyTasks(state) {
  const ready = [];
  for (const [id, node] of Object.entries(nodesOf(state))) {
    if (node && node.kind === "resolvable" && node.subkind === "task" && isTaskReady(state, id)) {
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

function collectTaskStatus(state, task, pools) {
  const { id, node, status } = task;
  if (node.subkind === "gate" || NON_OPEN_TASK_STATUSES.has(status)) {
    return;
  }
  if (node.backlog === true) {
    pools.backlog.push(id);
    return;
  }
  if (isTaskReady(state, id)) {
    pools.ready.push(id);
  } else {
    pools.blocked.push(id);
  }
}


export function deriveV2(state) {
  const pools = { ready: [], blocked: [], backlog: [], openGates: [] };
  const nodes = nodesOf(state);
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || node.kind !== "resolvable") {
      continue;
    }
    const status = node.status || "open";
    collectOpenGate(id, node, status, pools.openGates);
    collectTaskStatus(state, { id, node, status }, pools);
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


export function statusOfV2(state, id) {
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
  return isTaskReady(state, id) ? "ready" : "blocked";
}


export const isSatisfiedByGraph = isSatisfiedV2;
export const taskIsReadyByGraph = isTaskReady;
