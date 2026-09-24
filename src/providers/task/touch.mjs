// src/providers/task/touch.mjs — pure provider for `task.touch`.
//
// ADR-022 §C (D1):
//   - `prepare` is read-only. It validates the target is a task held in
//     `in_progress` by the requesting actor. Only the claim owner may
//     refresh the heartbeat.
//   - `apply` mutates the in-memory tx draft only: tx.updateNode to set
//     `claim.heartbeat_at`. Domain status, owner, `claim.at` and
//     `claim.meta` are preserved. Revision is never written.
//   - Imports nothing from filesystem, lock, state, log, policy,
//     commands, registry, adapters, CLI or UI. Only the v2 error
//     helpers are used.

import { throwV2 } from "../../contracts/errors.mjs";

const OP = "task.touch";
const LOG_ACTION = "touch";

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
  const touchedAt = input.touched_at === undefined ? new Date().toISOString() : input.touched_at;
  if (typeof touchedAt !== "string" || !Number.isFinite(Date.parse(touchedAt))) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input.touched_at must be a valid timestamp when present`, { field: "touched_at" });
  }
  return { actor, touchedAt };
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
      `${OP}: task '${input.id}' cannot be touched from status '${status}'`,
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
 * Pure `prepare` for task.touch.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  const { actor, touchedAt } = validateInputShape(input, request);
  const node = validateTarget(input, snapshot, actor);
  const currentHeartbeat = node.claim && node.claim.heartbeat_at;
  const parsedHeartbeat = typeof currentHeartbeat === "string" ? Date.parse(currentHeartbeat) : NaN;
  const nextHeartbeat = Number.isFinite(parsedHeartbeat) && Date.parse(touchedAt) <= parsedHeartbeat
    ? new Date(parsedHeartbeat + 1).toISOString()
    : new Date(Date.parse(touchedAt)).toISOString();
  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: REQUIRED_STATUS,
      previous_owner: actor,
    }),
    policyAction: Object.freeze({ action: OP, pluginId: null }),
    logAction: LOG_ACTION,
    heartbeat_at: nextHeartbeat,
  });
}

/**
 * Pure `apply` for task.touch. Preserves the claim owner, creation
 * instant and attempt metadata; only the heartbeat advances.
 *
 * @param {{ tx: object, plan: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
async function apply({ tx, plan }) {
  if (!tx || typeof tx.updateNode !== "function" || typeof tx.getNode !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with updateNode/getNode accessors`,
      { field: "tx" },
    );
  }
  const existing = tx.getNode(plan.target.id);
  const claim = (existing && existing.claim) || {};
  tx.updateNode(plan.target.id, {
    claim: { ...claim, heartbeat_at: plan.heartbeat_at },
  });
  const merged = tx.getNode(plan.target.id);
  return {
    result: Object.freeze({
      id: plan.target.id,
      status: merged ? merged.status : REQUIRED_STATUS,
      claim: merged && merged.claim ? Object.freeze({ ...merged.claim }) : null,
    }),
    effects: null,
  };
}

export const taskTouchProvider = Object.freeze({ prepare, apply });
