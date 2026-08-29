// src/providers/task/reopen.mjs — pure provider for `task.reopen`.
//
// Plan §B4-task-lifecycle + ADR-011 §§1–4:
//   - `prepare` is read-only. Validates input + target + status=done
//     and the required `reason`.
//   - `apply` uses tx.updateNode to roll back the terminal task to
//     `open`, clearing claim/done_by/done_at/note/resolution. Never
//     writes revision.
//   - Imports nothing from filesystem, lock, state, log, policy,
//     commands, registry, adapters, CLI or UI.

import { throwV2 } from "../../errors.mjs";

const OP = "task.reopen";
const LOG_ACTION = "reopen";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";
const TERMINAL_STATUS = "done";

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function validateInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  if (!asNonEmptyString(input.id)) {
    throwV2("MISSING_FIELD", `${OP}: --id required`, { field: "id" });
  }
  if (!asNonEmptyString(input.actor)) {
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
  if (status !== TERMINAL_STATUS) {
    throwV2(
      "INVALID_STATUS",
      `${OP}: task '${input.id}' is not ${TERMINAL_STATUS} (status=${status})`,
      { id: input.id, current: status, expected: TERMINAL_STATUS },
    );
  }
}

/**
 * Pure `prepare` for task.reopen.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  void request;
  validateInputShape(input);
  validateTarget(input, snapshot);
  const node = readSnapshotNodes(snapshot)[input.id];
  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: node.status,
      previous_done_by: node.done_by || null,
    }),
    policyAction: Object.freeze({ action: "task.reopen", pluginId: null }),
    logAction: LOG_ACTION,
    reason: input.reason,
  });
}

/**
 * Pure `apply` for task.reopen. Clears all terminal-task artifacts
 * (`done`, `done_by`, `done_at`, `note`, `resolution`, `claim`).
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
  const patch = { status: "open", claim: null };
  tx.updateNode(plan.target.id, patch);
  return {
    result: Object.freeze({
      id: plan.target.id,
      status: "open",
      previous_done_by: plan.target.previous_done_by,
    }),
    effects: null,
  };
}

export const taskReopenProvider = Object.freeze({ prepare, apply });
