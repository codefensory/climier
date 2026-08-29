// src/providers/task/release.mjs — pure provider for `task.release`.
//
// Plan §B4-task-lifecycle + ADR-011 §§1–4:
//   - `prepare` is read-only. Validates input + target, and detects
//     the no-claim idempotent short-circuit (the kernel diff will
//     see no change and skip the write + log).
//   - `apply` uses tx.updateNode to clear the claim and reset status
//     to `open`. Never writes revision.
//   - Imports nothing from filesystem, lock, state, log, policy,
//     commands, registry, adapters, CLI or UI.

import { throwV2 } from "../../errors.mjs";

const OP = "task.release";
const LOG_ACTION = "release";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";

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
}

/**
 * Pure `prepare` for task.release.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  validateInputShape(input, request);
  validateTarget(input, snapshot);
  const node = readSnapshotNodes(snapshot)[input.id];
  const hasClaim = !!(node.claim && node.claim.by);
  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      status: node.status || "open",
      had_claim: hasClaim,
      previous_owner: hasClaim ? node.claim.by : null,
    }),
    policyAction: Object.freeze({ action: "task.release", pluginId: null }),
    logAction: LOG_ACTION,
    idempotent: !hasClaim,
    previous_owner: hasClaim ? node.claim.by : null,
  });
}

/**
 * Pure `apply` for task.release. Idempotent when there is no claim
 * to release — kernel diff catches the no-op and skips write/log.
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
    const existing = tx.getNode(plan.target.id);
    return {
      result: Object.freeze({
        id: plan.target.id,
        released: false,
        claim: existing && existing.claim ? Object.freeze({ ...existing.claim }) : null,
        status: existing ? existing.status : "open",
      }),
      effects: null,
    };
  }
  const patch = { claim: null, status: "open" };
  tx.updateNode(plan.target.id, patch);
  return {
    result: Object.freeze({
      id: plan.target.id,
      released: true,
      claim: null,
      status: "open",
      previous_owner: plan.previous_owner || null,
    }),
    effects: null,
  };
}

export const taskReleaseProvider = Object.freeze({ prepare, apply });
