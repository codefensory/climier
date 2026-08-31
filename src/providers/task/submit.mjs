// src/providers/task/submit.mjs — pure provider for `task.submit`.
//
// Submission is the worker-owned transition from in_progress to submitted.
// The provider validates against the fresh snapshot and applies only through
// the transaction draft; locking, persistence, revisions and audit logging
// remain kernel responsibilities.

import { throwV2 } from "../../contracts/errors.mjs";

const OP = "task.submit";
const LOG_ACTION = "submit";
const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";
const REQUIRED_STATUS = "in_progress";

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
  const actor = resolveActor(input, request);
  if (!actor) {
    throwV2("MISSING_FIELD", `${OP}: input.actor required`, { field: "actor" });
  }
  if (!asNonEmptyString(input.note)) {
    throwV2("MISSING_FIELD", `${OP}: --note required`, { field: "note" });
  }
  if (input.submitted_at !== undefined && !asNonEmptyString(input.submitted_at)) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: input.submitted_at must be a non-empty string when present`,
      { field: "submitted_at" },
    );
  }
  return actor;
}

function validateTarget(input, snapshot, actor) {
  const node = readSnapshotNodes(snapshot)[input.id];
  if (!node) {
    throwV2("NODE_NOT_FOUND", `${OP}: task '${input.id}' not found`, { id: input.id });
  }
  if (node.kind !== TASK_KIND || node.subkind !== TASK_SUBKIND) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: node '${input.id}' is not a task (got ${node.kind}/${node.subkind || "?"})`,
      { id: input.id, kind: node.kind, subkind: node.subkind || null },
    );
  }
  const status = node.status || "open";
  if (status !== REQUIRED_STATUS) {
    throwV2(
      "INVALID_STATUS",
      `${OP}: task '${input.id}' cannot be submitted from status '${status}'`,
      { id: input.id, current: status, allowed: [REQUIRED_STATUS] },
    );
  }
  const owner = node.claim && asNonEmptyString(node.claim.by);
  if (!owner || owner !== actor) {
    throwV2(
      "NOT_OWNER",
      `${OP}: actor '${actor}' does not own task '${input.id}'`,
      { id: input.id, actor, owner: owner || null },
    );
  }
  return node;
}

/**
 * Pure `prepare` for task.submit.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  const actor = validateInputShape(input, request);
  const node = validateTarget(input, snapshot, actor);
  const submittedAt = input.submitted_at === undefined
    ? new Date().toISOString()
    : input.submitted_at;

  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: node.status || "open",
      previous_owner: actor,
    }),
    policyAction: Object.freeze({ action: OP, pluginId: null }),
    logAction: LOG_ACTION,
    note: input.note,
    submitted_by: actor,
    submitted_at: submittedAt,
  });
}

/**
 * Pure `apply` for task.submit. Submission deliberately has no readiness
 * effect: only a later acceptance can satisfy BLOCKS edges.
 *
 * @param {{ tx: object, plan: object }} args
 * @returns {Promise<{ result: object, effects: { newly_ready: string[] } }>}
 */
async function apply({ tx, plan }) {
  if (!tx || typeof tx.updateNode !== "function" || typeof tx.getNode !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode/getNode accessors`,
      { field: "tx" },
    );
  }

  tx.updateNode(plan.target.id, {
    status: "submitted",
    claim: null,
    note: plan.note,
    submitted_by: plan.submitted_by,
    submitted_at: plan.submitted_at,
  });

  const merged = tx.getNode(plan.target.id);
  let projection;
  if (merged) {
    const { revision, ...withoutRevision } = merged;
    void revision;
    projection = Object.freeze({
      ...withoutRevision,
      added_edges: Object.freeze([]),
    });
  } else {
    projection = Object.freeze({ id: plan.target.id, status: "submitted", claim: null, added_edges: Object.freeze([]) });
  }

  return {
    result: projection,
    effects: Object.freeze({ newly_ready: Object.freeze([]) }),
  };
}

export const taskSubmitProvider = Object.freeze({ prepare, apply });
