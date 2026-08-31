// src/providers/task/accept.mjs — pure provider for `task.accept`.
//
// ADR-015/016:
//   - `prepare` validates a task is in the explicit `submitted` state and
//     records the host actor and acceptance timestamp.
//   - `apply` changes only the transaction draft, preserving submission
//     metadata while marking the task done. It computes `newly_ready` by
//     comparing canonical readiness before and after the transition.
//   - This provider does not own persistence, locks, logs, or adapters.

import { throwV2 } from "../../contracts/errors.mjs";
import { collectReadyTasks } from "./derivation.mjs";

const OP = "task.accept";
const LOG_ACTION = "accept";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";
const REQUIRED_STATUS = "submitted";

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Actor identity is fixed by the host request. The input fallback preserves
// compatibility with direct/core callers that provide actor in their input.
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
  if (input.accepted_at !== undefined && !asNonEmptyString(input.accepted_at)) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: input.accepted_at must be a non-empty string when present`,
      { field: "accepted_at" },
    );
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
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: node '${input.id}' is not a task (got ${node.kind}/${node.subkind || "?"})`,
      {
        id: input.id,
        kind: node.kind,
        subkind: node.subkind || null,
      },
    );
  }
  const status = node.status || "open";
  if (status !== REQUIRED_STATUS) {
    throwV2(
      "INVALID_STATUS",
      `${OP}: task '${input.id}' cannot be accepted from status '${status}'`,
      { id: input.id, current: status, expected: REQUIRED_STATUS },
    );
  }
}

/**
 * Pure `prepare` for task.accept.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  const actor = validateInputShape(input, request);
  validateTarget(input, snapshot);
  const node = readSnapshotNodes(snapshot)[input.id];
  const acceptedAt = input.accepted_at === undefined
    ? new Date().toISOString()
    : input.accepted_at;

  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: node.status,
      submitted_by: node.submitted_by || null,
      submitted_at: node.submitted_at || null,
    }),
    policyAction: Object.freeze({ action: "task.accept", pluginId: null }),
    logAction: LOG_ACTION,
    done_by: node.submitted_by || null,
    done_at: acceptedAt,
    accepted_by: actor,
    accepted_at: acceptedAt,
  });
}

/**
 * Pure `apply` for task.accept. The transaction owns the draft; this provider
 * only requests the submitted-to-done patch and projects its graph effect.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: { newly_ready: string[] } }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  if (
    !tx ||
    typeof tx.updateNode !== "function" ||
    typeof tx.getNode !== "function" ||
    typeof tx.view !== "function"
  ) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode/getNode/view accessors`,
      { field: "tx" },
    );
  }

  const patch = {
    status: "done",
    done_by: plan.done_by,
    done_at: plan.done_at,
    accepted_by: plan.accepted_by,
    accepted_at: plan.accepted_at,
    claim: null,
  };
  tx.updateNode(plan.target.id, patch);

  const beforeReady = new Set(collectReadyTasks({
    nodes: readSnapshotNodes(snapshot),
    edges: readSnapshotEdges(snapshot),
  }));
  const afterReady = collectReadyTasks(tx.view());
  const newlyReady = afterReady.filter((id) => !beforeReady.has(id)).sort();

  const merged = tx.getNode(plan.target.id);
  const projection = merged
    ? { ...merged, added_edges: [] }
    : { id: plan.target.id };
  delete projection.revision;

  return {
    result: Object.freeze({ ...projection, added_edges: Object.freeze([]) }),
    effects: Object.freeze({ newly_ready: Object.freeze(newlyReady) }),
  };
}

export const taskAcceptProvider = Object.freeze({ prepare, apply });
