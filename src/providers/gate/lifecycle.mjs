// src/providers/gate/lifecycle.mjs — gate.resolve / gate.reopen / gate.cancel
// providers (ADR-011 §§1–4 + ADR-012 §3).
//
// Pure domain semantics for the gate lifecycle operations. The provider
// owns validation and the in-memory draft mutation; it never touches the
// filesystem, the lock, the persisted state, the log, policy, commands,
// the registry, adapters, the CLI or the UI, and it NEVER writes or
// increments `revision` (the kernel assigns revision once per apply).
//
// Each operation follows the same shape:
//
//   prepare({ snapshot, input, request })
//     // read-only; declares target, policyAction, logAction, affected,
//     // and the agent-facing if_revision(s) precondition.
//   apply({ tx, plan, snapshot })
//     // mutates ONLY the tx draft via updateNode; returns { result, effects }.
//
// Behavioural contract (ADR-009 §"Resto de operaciones"):
//
//   gate.resolve
//     - target: existing gate with status open|in_progress.
//     - input: { id, choice, rationale, if_revision? }
//     - choice/rationale are required together and only on gates whose
//       resolution_mode is "choice".
//     - resolution_mode "labor" / "approval" cannot resolve by choice:
//       INVALID_EXECUTION_CONTRACT.
//     - resolution stored as node.resolution = { choice, rationale }.
//     - log action: "resolve", note: <id>.
//     - policy action: "task.resolve" (consistent with the seam).
//     - effect: newly_ready = tasks that were blocked only by this gate
//       and become ready once it resolves.
//
//   gate.reopen
//     - target: existing gate with status "resolved".
//     - input: { id, reason, if_revision? }
//     - status -> open, clears node.resolution.
//     - log action: "reopen", note: <reason>.
//     - policy action: "task.reopen" (consistent with the seam).
//     - effect: newly_blocked = tasks that lose their only satisfied
//       blocker when the gate goes back to open.
//
//   gate.cancel
//     - target: existing gate with status open|in_progress.
//     - input: { id, reason, if_revision? }
//     - status -> canceled; clears node.claim if any.
//     - log action: "cancel", note: <reason>.
//     - policy action: "task.cancel" (consistent with the seam).
//     - effect: newly_blocked = tasks that lose their only satisfied
//       blocker when the gate moves to canceled (canceled gates never
//       satisfy, matching isSatisfiedV2).
//
// isSatisfied truth table (mirrors the task provider's graph semantics):
//   task:  done | archived => true
//   gate:  resolved       => true
//          superseded     => chain walk through SUPERSEDES
//          anything else  => false
// The provider uses a pure in-graph helper so it can evaluate isSatisfied
// against both the snapshot and the draft view without importing adapters.

import { throwV2 } from "../../contracts/errors.mjs";
import { GATE_STATUSES } from "./create.mjs";
import { diffReadyByGate, isSatisfiedByGraph } from "./semantics.mjs";

const RESOLVE_OP = "gate.resolve";
const REOPEN_OP = "gate.reopen";
const CANCEL_OP = "gate.cancel";

const RESOLVE_LOG = "resolve";
const REOPEN_LOG = "reopen";
const CANCEL_LOG = "cancel";

const RESOLVE_POLICY = "task.resolve";
const REOPEN_POLICY = "task.reopen";
const CANCEL_POLICY = "task.cancel";

// Statuses from which a gate can be resolved. The resolver accepts
// only open/in_progress gates.
const RESOLVABLE_STATUSES = Object.freeze(["open", "in_progress"]);
// Statuses from which a gate can be canceled. Matches cancel.mjs.
const CANCELABLE_STATUSES = Object.freeze(["open", "in_progress"]);
// Terminal gate status that reopen can roll back. Matches reopen.mjs.
const TERMINAL_STATUS = "resolved";

function asPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSnapshot(input) {
  return asPlainObject(input) ? input : {};
}

function readSnapshotNodes(snapshot) {
  return asPlainObject(snapshot.nodes) ? snapshot.nodes : {};
}

function readSnapshotEdges(snapshot) {
  return Array.isArray(snapshot.edges) ? snapshot.edges : [];
}

function optionalNonEmptyString(input, field, command) {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throwV2("MISSING_FIELD", `${command}: '${field}' must be a non-empty string`, { field });
  }
  return value.trim();
}

function requireNonEmptyString(input, field, command) {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throwV2("MISSING_FIELD", `${command}: '${field}' is required`, { field });
  }
  return value.trim();
}

function parseIfRevisions(input, command, affected) {
  const raw = input.if_revisions;
  if (raw === undefined || raw === null) {
    return affected.length === 0 ? { kind: "none" } : { kind: "multi", values: {} };
  }
  if (!asPlainObject(raw)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${command}: 'if_revisions' must be an object`, {
      field: "if_revisions",
    });
  }
  const values = { ...raw };
  for (const nodeId of affected) {
    if (!Object.prototype.hasOwnProperty.call(values, nodeId)) {
      throwV2(
        "MISSING_FIELD",
        `${command}: if_revisions['${nodeId}'] is required because the operation modifies that node`,
        { field: "if_revisions", id: nodeId },
      );
    }
    if (!Number.isInteger(values[nodeId])) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `${command}: if_revisions['${nodeId}'] must be an integer`,
        { field: "if_revisions", id: nodeId, value: values[nodeId] },
      );
    }
  }
  for (const nodeId of Object.keys(values)) {
    if (!affected.includes(nodeId)) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `${command}: if_revisions declares '${nodeId}' but the operation does not modify it`,
        { field: "if_revisions", id: nodeId, affected: [...affected] },
      );
    }
  }
  return affected.length === 0 ? { kind: "none" } : { kind: "multi", values };
}

function checkIfRevisions(snapshot, command, affected, nodes, ifRevisions) {
  if (affected.length === 0) return;
  const values = ifRevisions && asPlainObject(ifRevisions.values) ? ifRevisions.values : {};
  for (const nodeId of affected) {
    const expected = values[nodeId];
    if (expected === undefined) continue; // parseIfRevisions already rejected this.
    const current = nodes[nodeId] && Number.isInteger(nodes[nodeId].revision) ? nodes[nodeId].revision : null;
    if (current !== expected) {
      throwV2(
        "REVISION_CONFLICT",
        `${command}: node ${nodeId} changed since revision ${expected}`,
        { id: nodeId, expected, current },
      );
    }
  }
}

function loadTargetGate(snapshot, id, command, { terminalOnly = false, allowedStatuses = null } = {}) {
  const nodes = readSnapshotNodes(snapshot);
  const node = nodes[id];
  if (!node) throwV2("NODE_NOT_FOUND", `${command}: node ${id} not found`, { id });
  if (node.kind !== "resolvable" || node.subkind !== "gate") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${command}: node ${id} is not a gate (kind=${node.kind}, subkind=${node.subkind || "undefined"})`,
      { id, kind: node.kind, subkind: node.subkind || null },
    );
  }
  const status = node.status || "open";
  const allowed = allowedStatuses || (terminalOnly ? [TERMINAL_STATUS] : null);
  if (allowed && !allowed.includes(status)) {
    throwV2(
      "INVALID_STATUS",
      `${command}: gate ${id} cannot transition from status '${status}'`,
      { id, current: status, allowed: terminalOnly ? [TERMINAL_STATUS] : allowed },
    );
  }
  return node;
}

function readRevisionsForApply(input, command, affected) {
  const raw = input && input.if_revisions;
  if (raw === undefined || raw === null) {
    return affected.length === 0 ? null : {};
  }
  if (!asPlainObject(raw)) return {};
  const out = {};
  for (const id of affected) {
    out[id] = Number.isInteger(raw[id]) ? raw[id] : 0;
  }
  return out;
}

function applyResolutionPatch(tx, plan) {
  // updateNode never carries revision (transaction.mjs enforces).
  tx.updateNode(plan.target.id, {
    status: "resolved",
    resolution: { choice: plan.choice, rationale: plan.rationale },
  });
}

function applyReopenPatch(tx, plan) {
  // The reopen must drop the previous resolution so isSatisfied falls back
  // to the open status (false). updateNode never carries revision.
  tx.updateNode(plan.target.id, { status: "open" });
  // updateNode merges keys and does not expose deletion, so explicitly
  // clear the resolution with null. Derivations treat null as absent and
  // the persisted state keeps the field's cleared value unambiguous.
  tx.updateNode(plan.target.id, { resolution: null });
}

function applyCancelPatch(tx, plan) {
  const patch = { status: "canceled" };
  // Gates do not carry claims by design. Unlike task.cancel, this
  // operation therefore has no claim field to clear.
  void patch;
  tx.updateNode(plan.target.id, { status: "canceled" });
}

// ─────────────────────────────────────────────────────────────────────────
// gate.resolve
// ─────────────────────────────────────────────────────────────────────────

export async function prepareGateResolve({ snapshot, input }) {
  const command = RESOLVE_OP;
  const payload = readSnapshot(input);
  const id = requireNonEmptyString(payload, "id", command);
  const choice = requireNonEmptyString(payload, "choice", command);
  const rationale = requireNonEmptyString(payload, "rationale", command);

  const nodes = readSnapshotNodes(snapshot);
  const edges = readSnapshotEdges(snapshot);
  const node = loadTargetGate(snapshot, id, command, { allowedStatuses: RESOLVABLE_STATUSES });

  if (node.resolution_mode !== "choice") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${command}: choice/rationale are only applicable to gates with resolution_mode 'choice' (got '${node.resolution_mode || "open"}')`,
      { id, resolution_mode: node.resolution_mode || null, field: "choice" },
    );
  }

  // Validate the gate's own revision before declaring the plan; the
  // declared affected is just [id] because lifecycle providers don't
  // touch any other node (no edges change).
  const affected = [id];
  const ifRevisions = parseIfRevisions(payload, command, affected);
  checkIfRevisions(snapshot, command, affected, nodes, ifRevisions);

  // Compute projected readiness against an in-memory "after" graph. The
  // apply phase redoes the same computation against the real draft; we
  // compute it here so prepare can document the effect in the plan.
  const projectedNodes = { ...nodes };
  projectedNodes[id] = {
    ...node,
    status: "resolved",
    resolution: { choice, rationale },
  };
  const projectedEdges = edges;
  const projectedGraph = { nodes: projectedNodes, edges: projectedEdges };
  const snapshotGraph = { nodes, edges };
  const newlyReady = diffReadyByGate(snapshotGraph, projectedGraph, id, "up");

  return {
    target: { id, kind: "resolvable", subkind: "gate" },
    policyAction: { action: RESOLVE_POLICY },
    logAction: RESOLVE_LOG,
    logNote: id,
    logFields: { choice, rationale },
    affected,
    if_revisions: ifRevisions,
    node: null,
    edges: [],
    rewrites: [],
    choice,
    rationale,
    projected: { newly_ready: newlyReady },
  };
}

export async function applyGateResolve({ tx, plan, snapshot }) {
  applyResolutionPatch(tx, plan);
  const snapshotGraph = {
    nodes: readSnapshotNodes(snapshot),
    edges: readSnapshotEdges(snapshot),
  };
  const view = tx.view();
  const viewGraph = { nodes: view.nodes, edges: view.edges };
  const newlyReady = diffReadyByGate(snapshotGraph, viewGraph, plan.target.id, "up");

  return {
    result: {
      node: tx.getNode(plan.target.id),
      resolution: { choice: plan.choice, rationale: plan.rationale },
    },
    effects: {
      newly_ready: newlyReady,
      affected: [...plan.affected],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// gate.reopen
// ─────────────────────────────────────────────────────────────────────────

export async function prepareGateReopen({ snapshot, input }) {
  const command = REOPEN_OP;
  const payload = readSnapshot(input);
  const id = requireNonEmptyString(payload, "id", command);
  const reason = requireNonEmptyString(payload, "reason", command);

  const nodes = readSnapshotNodes(snapshot);
  const edges = readSnapshotEdges(snapshot);
  loadTargetGate(snapshot, id, command, { terminalOnly: true });

  const affected = [id];
  const ifRevisions = parseIfRevisions(payload, command, affected);
  checkIfRevisions(snapshot, command, affected, nodes, ifRevisions);

  const node = nodes[id];
  // For reopened-from-superseded gates we still rollback to status=open
  // (matching reopen.mjs), so the projected graph clears the resolution
  // field too. cancel/superseded chains are out of scope for reopen here.
  const projectedNodes = { ...nodes };
  projectedNodes[id] = { ...node, status: "open", resolution: undefined };
  const newlyBlocked = diffReadyByGate(
    { nodes, edges },
    { nodes: projectedNodes, edges },
    id,
    "down",
  );

  return {
    target: { id, kind: "resolvable", subkind: "gate" },
    policyAction: { action: REOPEN_POLICY },
    logAction: REOPEN_LOG,
    logNote: reason,
    logFields: { reason },
    affected,
    if_revisions: ifRevisions,
    node: null,
    edges: [],
    rewrites: [],
    reason,
    projected: { newly_blocked: newlyBlocked },
  };
}

export async function applyGateReopen({ tx, plan, snapshot }) {
  applyReopenPatch(tx, plan);
  const snapshotGraph = {
    nodes: readSnapshotNodes(snapshot),
    edges: readSnapshotEdges(snapshot),
  };
  const view = tx.view();
  const viewGraph = { nodes: view.nodes, edges: view.edges };
  const newlyBlocked = diffReadyByGate(snapshotGraph, viewGraph, plan.target.id, "down");

  return {
    result: { node: tx.getNode(plan.target.id) },
    effects: {
      newly_blocked: newlyBlocked,
      affected: [...plan.affected],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// gate.cancel
// ─────────────────────────────────────────────────────────────────────────

export async function prepareGateCancel({ snapshot, input }) {
  const command = CANCEL_OP;
  const payload = readSnapshot(input);
  const id = requireNonEmptyString(payload, "id", command);
  const reason = requireNonEmptyString(payload, "reason", command);

  const nodes = readSnapshotNodes(snapshot);
  const edges = readSnapshotEdges(snapshot);
  loadTargetGate(snapshot, id, command, { allowedStatuses: CANCELABLE_STATUSES });

  const affected = [id];
  const ifRevisions = parseIfRevisions(payload, command, affected);
  checkIfRevisions(snapshot, command, affected, nodes, ifRevisions);

  const node = nodes[id];
  const projectedNodes = { ...nodes };
  projectedNodes[id] = { ...node, status: "canceled" };
  const newlyBlocked = diffReadyByGate(
    { nodes, edges },
    { nodes: projectedNodes, edges },
    id,
    "down",
  );

  return {
    target: { id, kind: "resolvable", subkind: "gate" },
    policyAction: { action: CANCEL_POLICY },
    logAction: CANCEL_LOG,
    logNote: reason,
    logFields: { reason },
    affected,
    if_revisions: ifRevisions,
    node: null,
    edges: [],
    rewrites: [],
    reason,
    projected: { newly_blocked: newlyBlocked },
  };
}

export async function applyGateCancel({ tx, plan, snapshot }) {
  applyCancelPatch(tx, plan);
  const snapshotGraph = {
    nodes: readSnapshotNodes(snapshot),
    edges: readSnapshotEdges(snapshot),
  };
  const view = tx.view();
  const viewGraph = { nodes: view.nodes, edges: view.edges };
  const newlyBlocked = diffReadyByGate(snapshotGraph, viewGraph, plan.target.id, "down");

  return {
    result: { node: tx.getNode(plan.target.id) },
    effects: {
      newly_blocked: newlyBlocked,
      affected: [...plan.affected],
    },
  };
}

export const gateResolveProvider = Object.freeze({ prepare: prepareGateResolve, apply: applyGateResolve });
export const gateReopenProvider = Object.freeze({ prepare: prepareGateReopen, apply: applyGateReopen });
export const gateCancelProvider = Object.freeze({ prepare: prepareGateCancel, apply: applyGateCancel });

// Public constants consumed by the registry and adapter.
export const GATE_RESOLVE_OP = RESOLVE_OP;
export const GATE_REOPEN_OP = REOPEN_OP;
export const GATE_CANCEL_OP = CANCEL_OP;
export const GATE_RESOLVE_POLICY_ACTION = RESOLVE_POLICY;
export const GATE_REOPEN_POLICY_ACTION = REOPEN_POLICY;
export const GATE_CANCEL_POLICY_ACTION = CANCEL_POLICY;
export const GATE_RESOLVE_LOG_ACTION = RESOLVE_LOG;
export const GATE_REOPEN_LOG_ACTION = REOPEN_LOG;
export const GATE_CANCEL_LOG_ACTION = CANCEL_LOG;
export const GATE_RESOLVABLE_STATUSES = RESOLVABLE_STATUSES;
export const GATE_CANCELABLE_STATUSES = CANCELABLE_STATUSES;

// Re-export for downstream consumers that want a single import surface.
export { isSatisfiedByGraph, diffReadyByGate, GATE_STATUSES };
// Suppress unused-export warning for readRevisionsForApply (kept for parity
// with create.mjs should the lifecycle ever need to read declared revisions
// back from a plan).
void readRevisionsForApply;
