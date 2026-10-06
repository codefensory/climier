// src/providers/knowledge/deprecate.ts — `knowledge.deprecate` provider
// for the graph kernel.

//   - `prepare({ snapshot, input, request }) → plan`
//       read-only; validates that the target is an existing knowledge
//       node; surfaces the current revision as `if_revision` so the
//       kernel can validate the CAS under the lock; captures the
//       actor (request.actor) for the deprecation record.
//   - `apply({ tx, plan }) → { result, effects }`
//       patches the draft via `tx.updateNode`. Sets `status`,
//       `deprecation_reason`, `deprecated_at`, `deprecated_by` and
//       leaves every other field untouched (scope, knowledge_type,
//       mitigation, title, body, refs, meta, …). The kernel owns
//       revision assignment; this file never reads or writes the
//       `revision` field (see src/kernel/mutate.ts + transaction.mjs).


// and `deprecated_by` (the actor that ran the operation).
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI. The only side effect is on the
// caller-supplied `tx` draft.

import { throwV2 } from "../../contracts/errors.ts";

const POLICY_ACTION = "knowledge.deprecate";
const COMMAND_OP = "knowledge.deprecate";

function asPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}: snapshot must be an object`, { field: "snapshot" });
  }
  return snapshot;
}

function readInput(input) {
  if ((input === null || input === undefined) || typeof input !== "object" || Array.isArray(input)) {
    throwV2("MISSING_FIELD", `${COMMAND_OP}: input must be an object`, { field: "input" });
  }
  return input;
}

function readRequest(request) {
  if (!request || typeof request !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}: request must be an object`, { field: "request" });
  }
  return request;
}

function readSnapshotNodes(snapshot) {
  return asPlainObject(snapshot.nodes) ? snapshot.nodes : {};
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0 || !value.trim()) {
    throwV2("MISSING_FIELD", `${COMMAND_OP}: '${field}' is required`, { field });
  }
  return value.trim();
}

function validateTarget(nodes, id) {
  const current = nodes[id];
  if (!current) {
    throwV2("NODE_NOT_FOUND", `${COMMAND_OP}: node '${id}' does not exist`, { id });
  }
  if (current.kind !== "knowledge") {
    throwV2(
      "INVALID_PROVIDER_INPUT",
      `${COMMAND_OP}: node '${id}' is not a knowledge node (kind=${current.kind})`,
      { id, kind: current.kind },
    );
  }
  if (!Number.isInteger(current.revision)) {
    throwV2(
      "INVALID_PROVIDER_INPUT",
      `${COMMAND_OP}: node '${id}' has no integer revision`,
      { id, revision: current.revision },
    );
  }
  return current;
}

async function prepare({ snapshot: rawSnapshot, input: rawInput, request: rawRequest }) {
  const snapshot = readSnapshot(rawSnapshot);
  const input = readInput(rawInput);
  const request = readRequest(rawRequest);
  const id = requireNonEmptyString(input.id, "id");
  const reason = requireNonEmptyString(input.reason, "reason");
  const actor = requireNonEmptyString(request.actor, "actor");
  const current = validateTarget(readSnapshotNodes(snapshot), id);
  return {
    target: { id, kind: "knowledge", revision: current.revision },
    if_revision: { kind: "single", id, value: current.revision },
    policyAction: { action: POLICY_ACTION },
    idempotent: false,
    reason,
    actor,
  };
}

function readPlanTarget(plan) {
  if (!plan.target || typeof plan.target.id !== "string" || plan.target.id.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}.apply: plan.target.id missing`, { field: "plan.target.id" });
  }
  return plan.target.id;
}

function readPlanText(plan, field) {
  const value = typeof plan[field] === "string" ? plan[field] : null;
  if (value === null) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}.apply: plan.${field} missing`, { field: `plan.${field}` });
  }
  return value;
}

function validateApplyPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND_OP}.apply: plan missing`, { field: "plan" });
  }
  return {
    id: readPlanTarget(plan),
    reason: readPlanText(plan, "reason"),
    actor: readPlanText(plan, "actor"),
  };
}

async function apply({ tx, plan }) {
  const { id, reason, actor } = validateApplyPlan(plan);
  tx.updateNode(id, {
    status: "deprecated",
    deprecation_reason: reason,
    deprecated_at: new Date().toISOString(),
    deprecated_by: actor,
  });
  return {
    result: { id, kind: "knowledge", status: "deprecated" },
    effects: null,
  };
}


export function deprecateProvider() {
  return { prepare, apply };
}
