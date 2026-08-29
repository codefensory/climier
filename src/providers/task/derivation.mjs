// src/providers/task/derivation.mjs — canonical task graph derivation.
//
// ADR-011 §2 + ADR-012 §3: task status, blocker satisfaction and readiness
// are pure provider semantics. This module deliberately has no filesystem,
// transaction, lock, persistence, log, command, registry or adapter imports.
// It accepts a v2 state-shaped graph and never mutates it.

const TERMINAL_TASK_STATUSES = new Set(["in_progress", "done", "archived", "canceled"]);
const SATISFIED_TASK_STATUSES = new Set(["done", "archived"]);
const SATISFIED_GATE_STATUSES = new Set(["resolved"]);

function nodesOf(state) {
  return state && state.nodes && typeof state.nodes === "object" ? state.nodes : {};
}

function edgesOf(state) {
  return Array.isArray(state && state.edges) ? state.edges : [];
}

/**
 * Return the deterministic superseding gate for a node, if one exists.
 * SUPERSEDES points from the replacement to the replaced node.
 */
export function supersededBy(state, id) {
  return edgesOf(state)
    .filter((edge) => edge.type === "SUPERSEDES" && edge.to === id)
    .map((edge) => edge.from)
    .sort()[0] || null;
}

/**
 * Whether a node satisfies a BLOCKS dependency.
 *
 * Unknown nodes and knowledge nodes are intentionally unsatisfied. A
 * superseded gate follows its replacement chain, with cycle protection so a
 * malformed graph remains blocked instead of overflowing the stack.
 */
export function isSatisfiedV2(state, id, seen = new Set()) {
  const nodes = nodesOf(state);
  const node = nodes[id];
  if (!node || node.kind === "knowledge" || seen.has(id)) return false;

  const status = node.status || "open";
  if (node.subkind === "task") return SATISFIED_TASK_STATUSES.has(status);
  if (node.subkind !== "gate") return false;
  if (status === "resolved") return true;
  if (status !== "superseded") return false;

  const nextId = supersededBy(state, id);
  if (!nextId) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(id);
  return isSatisfiedV2(state, nextId, nextSeen);
}

/**
 * Whether a task is currently claimable/ready in the graph.
 *
 * An unknown blocker is unsatisfied by design. Cycles of open tasks therefore
 * remain blocked without requiring a separate topological traversal.
 */
export function isTaskReady(state, id) {
  const nodes = nodesOf(state);
  const node = nodes[id];
  if (!node || node.kind !== "resolvable" || node.subkind !== "task") return false;

  const status = node.status || "open";
  if (TERMINAL_TASK_STATUSES.has(status) || node.backlog === true) return false;

  return edgesOf(state)
    .filter((edge) => edge.type === "BLOCKS" && edge.to === id)
    .every((edge) => isSatisfiedV2(state, edge.from));
}

// Short aliases make the provider's domain vocabulary usable without tying
// callers to the historical v2 suffix. The v2-named functions above remain
// the compatibility surface consumed by the future v2 facade.
export const isReady = isTaskReady;
export const readiness = isTaskReady;

/**
 * Return all task ids that are ready in deterministic insertion order.
 */
export function collectReadyTasks(state) {
  const ready = [];
  for (const [id, node] of Object.entries(nodesOf(state))) {
    if (node && node.kind === "resolvable" && node.subkind === "task" && isTaskReady(state, id)) {
      ready.push(id);
    }
  }
  return ready;
}

/**
 * Derive the v2 task pools and open gates.
 *
 * This preserves the existing read contract: lifecycle statuses stay in their
 * own buckets (and out of ready/blocked), backlog tasks are separate, and
 * open gates are reported separately from tasks.
 */
export function deriveV2(state) {
  const ready = [];
  const blocked = [];
  const backlog = [];
  const openGates = [];
  const nodes = nodesOf(state);

  for (const [id, node] of Object.entries(nodes)) {
    if (!node || node.kind !== "resolvable") continue;
    const status = node.status || "open";
    if (node.subkind === "gate") {
      if (status === "open") openGates.push(id);
      continue;
    }
    if (TERMINAL_TASK_STATUSES.has(status)) continue;
    if (node.backlog === true) {
      backlog.push(id);
      continue;
    }
    if (isTaskReady(state, id)) ready.push(id);
    else blocked.push(id);
  }

  return { ready, blocked, backlog, openGates };
}

/**
 * Historical status projection used by the CLI and UI consumers.
 */
export function statusOfV2(state, id) {
  const node = nodesOf(state)[id];
  if (!node) return "unknown";
  if (node.kind === "knowledge") return node.status || "active";

  const status = node.status || "open";
  if (["in_progress", "done", "archived", "canceled", "resolved", "superseded"].includes(status)) {
    return status;
  }
  if (node.backlog === true) return "backlog";
  if (isTaskReady(state, id)) return "ready";
  return "blocked";
}

// Explicit provider vocabulary for lifecycle projections. The aliases avoid
// lifecycle modules having to recreate the same graph walk under a different
// local helper name.
export const isSatisfiedByGraph = isSatisfiedV2;
export const taskIsReadyByGraph = isTaskReady;
