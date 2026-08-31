// src/providers/task/reject.mjs — pure provider for `task.reject`.
//
// ADR-015/016: reject is the typed submitted -> open transition. The
// provider validates the lifecycle state and reason, updates only the
// transaction draft, and supplies the reason as an allow-listed log field for
// the kernel's atomic state-plus-log commit.
//
// This module intentionally has no filesystem, lock, state, log, policy,
// command, registry, adapter, CLI, or UI dependencies.

import { throwV2 } from "../../contracts/errors.mjs";

const OP = "task.reject";
const LOG_ACTION = "reject";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";
const SUBMITTED_STATUS = "submitted";

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

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

function validateInputShape(input, request) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  if (!asNonEmptyString(input.id)) {
    throwV2("MISSING_FIELD", `${OP}: --id required`, { field: "id" });
  }
  if (!resolveActor(input, request)) {
    throwV2("MISSING_FIELD", `${OP}: input.actor required`, { field: "actor" });
  }
  if (!asNonEmptyString(input.reason)) {
    throwV2("MISSING_FIELD", `${OP}: --reason required`, { field: "reason" });
  }
}

function validateTarget(input, snapshot) {
  const node = readSnapshotNodes(snapshot)[input.id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${OP}: task '${input.id}' not found`, { id: input.id });
  }
  if (node.kind !== TASK_KIND || node.subkind !== TASK_SUBKIND) {
    throwV2(
      "INVALID_STATUS",
      `${OP}: node '${input.id}' is not a task (got ${node.kind}/${node.subkind || "?"})`,
      {
        id: input.id,
        kind: node.kind,
        subkind: node.subkind || null,
      },
    );
  }
  const status = node.status || "open";
  if (status !== SUBMITTED_STATUS) {
    throwV2(
      "INVALID_STATUS",
      `${OP}: task '${input.id}' is not ${SUBMITTED_STATUS} (status=${status})`,
      { id: input.id, current: status, expected: SUBMITTED_STATUS },
    );
  }
}

/**
 * Pure `prepare` for task.reject.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  validateInputShape(input, request);
  validateTarget(input, snapshot);
  const node = readSnapshotNodes(snapshot)[input.id];
  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: node.status,
    }),
    policyAction: Object.freeze({ action: OP, pluginId: null }),
    logAction: LOG_ACTION,
    logFields: Object.freeze({ reason: input.reason }),
    reason: input.reason,
  });
}

/**
 * Pure `apply` for task.reject. The four submission/acceptance metadata
 * fields are explicit nulls so the next open cycle cannot inherit the
 * previous submission. Claim ownership is implementation-only and is also
 * cleared. No revision or log is written here.
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.updateNode !== "function" || typeof tx.getNode !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode/getNode accessors`,
      { field: "tx" },
    );
  }

  tx.updateNode(plan.target.id, {
    status: "open",
    claim: null,
    submitted_by: null,
    submitted_at: null,
    accepted_by: null,
    accepted_at: null,
  });

  const merged = tx.getNode(plan.target.id);
  const projection = merged
    ? Object.freeze({ ...merged, added_edges: Object.freeze([]) })
    : Object.freeze({ id: plan.target.id, status: "open" });
  delete projection.revision;

  return {
    result: projection,
    effects: null,
  };
}

export const taskRejectProvider = Object.freeze({ prepare, apply });
