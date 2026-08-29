// src/providers/task/take.mjs — pure provider for `task.take` / `task.takeover`.
//
// Plan §B4-task-lifecycle + ADR-011 §§1–4:
//   - `prepare` is read-only. It classifies the action (task.take vs
//     task.takeover), validates the target is a task in a claimable
//     state, and detects the same-actor idempotent short-circuit.
//   - `apply` mutates the in-memory tx draft only: tx.updateNode to
//     install the new claim and `in_progress` status. The takeover
//     path carries `previous_owner` in the plan so the adapter can
//     surface it in the log; the provider never writes the log
//     directly. Revision is never written.
//   - Imports nothing from filesystem, lock, state, log, policy,
//     commands, registry, adapters, CLI or UI. Only the v2 error
//     helpers are used.

import { throwV2 } from "../../errors.mjs";

const OP = "task.take";
const LOG_ACTION = "take";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";

const SATISFIED_TASK = new Set(["done", "archived"]);
const SATISFIED_GATE = new Set(["resolved"]);

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// resolveActor — host-fixed agent identity comes from request.actor
// (the kernel stamps it from createCore's agent argument); the CLI
// surface historically forwards --as through flags.as and ends up
// here as input.actor. Both shapes remain accepted so the legacy CLI
// path keeps working, but request.actor wins when both are present:
// the adapter is the canonical source of truth for agent identity
// in plugin-issued calls (ADR-006 §API y compatibilidad).
function resolveActor(input, request) {
  return (
    asNonEmptyString(request && request.actor) ||
    asNonEmptyString(input && input.actor) ||
    null
  );
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function readSnapshotEdges(snapshot) {
  return Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : [];
}

function validateInputShape(input, request) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  if (!asNonEmptyString(input.id)) {
    throwV2("MISSING_FIELD", `${OP}: --id required`, { field: "id" });
  }
  const actor = resolveActor(input, request);
  if (!actor) {
    throwV2("MISSING_FIELD", `${OP}: input.actor required`, { field: "actor" });
  }
  const at = input.at === undefined ? new Date().toISOString() : input.at;
  if (typeof at !== "string" || at.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input.at must be an ISO string when present`, { field: "at" });
  }
  return actor;
}

function validateTarget(input, snapshot) {
  const node = readSnapshotNodes(snapshot)[input.id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${OP}: task '${input.id}' not found`, { id: input.id });
  }
  if (node.kind !== TASK_KIND || node.subkind !== TASK_SUBKIND) {
    throwV2(
      "NOT_CLAIMABLE",
      `${OP}: node '${input.id}' is not a task (got ${node.kind}/${node.subkind || "?"})`,
      {
        id: input.id,
        kind: node.kind,
        subkind: node.subkind || null,
        expectedKind: TASK_KIND,
        expectedSubkind: TASK_SUBKIND,
      },
    );
  }
}

// isBlockerSatisfied — minimal mirror of v2.mjs#isSatisfiedV2 sufficient
// for the readiness gate in `task.take`. We intentionally do not follow
// superseded chains: a fresh task with no in-progress sibling is gated
// on direct status only, matching the v2 semantics used by statusOfV2.
function isBlockerSatisfied(blocker) {
  if (!blocker) return false;
  const status = blocker.status || "open";
  if (blocker.subkind === "task") return SATISFIED_TASK.has(status);
  if (blocker.subkind === "gate") return SATISFIED_GATE.has(status);
  return false;
}

function isTaskReady(node, snapshot) {
  const edges = readSnapshotEdges(snapshot);
  const blockers = edges.filter((e) => e.type === "BLOCKS" && e.to === node.id);
  if (blockers.length === 0) return true;
  const nodes = readSnapshotNodes(snapshot);
  return blockers.every((e) => isBlockerSatisfied(nodes[e.from]));
}

// classifyAction — runs against the snapshot (read-only). Returns a
// frozen descriptor consumed by prepare/apply. The semantic matrix
// matches the v2 take command (ADR-008 §"Tabla de take"):
//
//   status        | claim.by    | action         | takeover | idempotent
//   --------------|-------------|----------------|----------|------------
//   in_progress   | same actor  | task.take      | false    | true
//   in_progress   | other actor | task.takeover  | true     | false
//   open          | n/a         | task.take      | false    | false
//   open + blocked deps         | NOT_READY
//   any other status            | NOT_READY
function classifyAction(node, actor, snapshot) {
  const status = node.status || "open";
  const owner = node.claim && node.claim.by ? node.claim.by : null;

  if (status === "in_progress" && owner === actor) {
    return Object.freeze({
      action: "task.take",
      takeover: false,
      idempotent: true,
      previous_owner: null,
    });
  }
  if (status === "in_progress" && owner && owner !== actor) {
    return Object.freeze({
      action: "task.takeover",
      takeover: true,
      idempotent: false,
      previous_owner: owner,
    });
  }
  if (status !== "open") {
    throwV2(
      "NOT_READY",
      `${OP}: task '${node.id}' is '${status}', not ready`,
      { id: node.id, status },
    );
  }
  if (!isTaskReady(node, snapshot)) {
    throwV2(
      "NOT_READY",
      `${OP}: task '${node.id}' is blocked by unfinished deps`,
      { id: node.id, status },
    );
  }
  return Object.freeze({
    action: "task.take",
    takeover: false,
    idempotent: false,
    previous_owner: null,
  });
}

/**
 * Pure `prepare` for task.take / task.takeover.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  const actor = validateInputShape(input, request);
  validateTarget(input, snapshot);
  const node = readSnapshotNodes(snapshot)[input.id];
  const cls = classifyAction(node, actor, snapshot);
  const at = input.at === undefined ? new Date().toISOString() : input.at;

  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: node.status || "open",
      previous_owner: cls.previous_owner,
      takeover: cls.takeover,
    }),
    policyAction: Object.freeze({ action: cls.action, pluginId: null }),
    logAction: LOG_ACTION,
    idempotent: cls.idempotent,
    takeover: cls.takeover,
    previous_owner: cls.previous_owner,
    claim: Object.freeze({ by: actor, at }),
  });
}

/**
 * Pure `apply` for task.take / task.takeover.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.updateNode !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode accessor`,
      { field: "tx" },
    );
  }
  if (plan.idempotent) {
    // Same actor already holds the claim. ADR-008 §"Tabla de take":
    // idempotent, no mutation. The kernel diff will see no change and
    // skip both the write and the log append.
    const existing = tx.getNode(plan.target.id);
    return {
      result: Object.freeze({
        id: plan.target.id,
        claim: existing && existing.claim ? Object.freeze({ ...existing.claim }) : null,
        status: existing ? existing.status : "in_progress",
        freshly_claimed: false,
      }),
      effects: null,
    };
  }
  // apply MUST NOT carry revision; the kernel assigns it.
  const patch = { claim: { by: plan.claim.by, at: plan.claim.at }, status: "in_progress" };
  tx.updateNode(plan.target.id, patch);
  return {
    result: Object.freeze({
      id: plan.target.id,
      claim: Object.freeze({ by: plan.claim.by, at: plan.claim.at }),
      status: "in_progress",
      freshly_claimed: true,
      takeover: plan.takeover === true,
      previous_owner: plan.previous_owner || null,
    }),
    effects: null,
  };
}

export const taskTakeProvider = Object.freeze({ prepare, apply });
