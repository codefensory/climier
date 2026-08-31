// src/providers/task/cancel.mjs — pure provider for `task.cancel`.
//
// ADR-011 §§1–4:
//   - `prepare` is read-only. Validates input + target + allowed
//     statuses (open / in_progress / submitted) and the required `reason`.
//   - `apply` uses tx.updateNode to set status=canceled and clear
//     the claim. Never writes revision.
//   - Imports nothing from filesystem, lock, state, log, policy,
//     commands, registry, adapters, CLI or UI.

import { throwV2 } from "../../contracts/errors.mjs";

const OP = "task.cancel";
const LOG_ACTION = "cancel";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";
const ALLOWED_STATUSES = ["open", "in_progress", "submitted"];

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// resolveActor — host-fixed agent identity comes from request.actor
// (the kernel stamps it from createCore's agent argument); the CLI
// surface forwards --as through flags.as and may expose it as
// input.actor. Both shapes remain accepted for compatibility, but
// request.actor wins when both are present:
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
  if (!asNonEmptyString(input.reason)) {
    throwV2("MISSING_FIELD", `${OP}: --reason required`, { field: "reason" });
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
  if (!ALLOWED_STATUSES.includes(status)) {
    throwV2(
      "INVALID_STATUS",
      `${OP}: task '${input.id}' cannot be canceled from status '${status}'`,
      { id: input.id, current: status, allowed: ALLOWED_STATUSES },
    );
  }
}

/**
 * Pure `prepare` for task.cancel.
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
      status: node.status || "open",
      previous_owner: node.claim && node.claim.by ? node.claim.by : null,
    }),
    policyAction: Object.freeze({ action: "task.cancel", pluginId: null }),
    logAction: LOG_ACTION,
    reason: input.reason,
  });
}

/**
 * Pure `apply` for task.cancel.
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
  const patch = { status: "canceled", claim: null };
  tx.updateNode(plan.target.id, patch);
  return {
    result: Object.freeze({
      id: plan.target.id,
      status: "canceled",
      previous_owner: plan.target.previous_owner,
    }),
    effects: null,
  };
}

export const taskCancelProvider = Object.freeze({ prepare, apply });
