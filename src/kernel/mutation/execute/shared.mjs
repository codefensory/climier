// Shared execution contracts and helpers used by mutation phases.

import fs from "node:fs/promises";
import { readState, stateFile } from "../../../storage/state.mjs";
import { readFencedStateUnderLock } from "../../../storage/ledger.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";
import {
  commandLabel,
  operationLabel,
  validatePlan,
  validateProvider,
  validateRequest,
} from "../request.mjs";
import { checkPrecondition, checkStateRevision, selectPrecondition } from "../preconditions.mjs";
import { assignNodeRevision } from "../revisions.mjs";
import { normalizeLogFields } from "../validation.mjs";

export { commandLabel, operationLabel, validateProvider, checkStateRevision, selectPrecondition, checkPrecondition, normalizeLogFields, assignNodeRevision };

function validateBatch(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate(core.batch): batch must be an object", { field: "batch" });
  }
  if (!batch.registry || typeof batch.registry !== "object" || typeof batch.registry.lookup !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate(core.batch): batch.registry.lookup must be a function", { field: "batch.registry" });
  }
}

export function validateMutationArguments({ request, provider, stateOperation, batch } = {}) {
  validateRequest(request);
  if (batch !== undefined) {
    if (request.action !== "core.batch") {
      throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: batch is only valid for core.batch", { field: "batch" });
    }
    validateBatch(batch);
    return operationLabel(request);
  }
  if (stateOperation !== undefined) {
    if (!stateOperation || typeof stateOperation !== "object" ||
        typeof stateOperation.prepare !== "function" || typeof stateOperation.apply !== "function") {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        "kernel.mutate: stateOperation must provide prepare and apply",
        { field: "stateOperation" },
      );
    }
  } else {
    validateProvider(provider);
  }
  return operationLabel(request);
}

export function freezePlan(prepareResult, commandName) {
  validatePlan(prepareResult, commandName);
  const plan = Object.freeze({
    target: Object.freeze({ ...prepareResult.target }),
    policyAction: prepareResult.policyAction && typeof prepareResult.policyAction === "object" && !Array.isArray(prepareResult.policyAction)
      ? prepareResult.policyAction
      : null,
    ...Object.fromEntries(
      Object.entries(prepareResult).filter(([key]) => key !== "target" && key !== "policyAction"),
    ),
  });
  const frozenExtras = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === "target") continue;
    frozenExtras[key] = (value && typeof value === "object") ? Object.freeze(value) : value;
  }
  return Object.freeze({ ...frozenExtras, target: plan.target });
}

export async function runPolicy(policyAction, snapshot, plan, request, commandName) {
  if (!policyAction || typeof policyAction !== "object" || typeof policyAction.decide !== "function") return;
  const action = typeof policyAction.action === "string" && policyAction.action.length > 0
    ? policyAction.action
    : request.action;
  const actor = typeof request.actor === "string" ? request.actor : "";
  const pluginId = policyAction.pluginId || null;
  const policySnapshot = { ...snapshot };
  delete policySnapshot.fence_generation;
  let decision;
  try {
    decision = await policyAction.decide({ snapshot: policySnapshot, target: plan.target, request, action });
  } catch (err) {
    if (err && typeof err.code === "string" && err.code.startsWith("POLICY_") && err.details !== undefined) {
      throw err;
    }
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: policyAction.decide threw: ${err && err.message ? err.message : String(err)}`,
      { action, cause: err && err.code ? err.code : null },
    );
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: policyAction.decide must return an object`, { field: "policyAction" });
  }
  if (decision.decision === "deny") {
    throwV2(
      "POLICY_DENIED",
      `${commandName}: action ${action} denied by policy for actor '${actor}': ${typeof decision.reason === "string" ? decision.reason : "(no reason)"}`,
      {
        plugin_id: pluginId,
        policy_id: pluginId,
        action,
        actor,
        reason: typeof decision.reason === "string" ? decision.reason : null,
      },
    );
  }
  if (decision.decision !== "allow" && decision.decision !== "abstain") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: policyAction.decide returned an unknown decision: ${JSON.stringify(decision.decision)}`,
      { field: "policyAction.decision", value: decision.decision },
    );
  }
}

export function cloneBatchValue(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate(core.batch): result must be cloneable JSON data", {
      field: "batch.result",
      cause: err && err.name ? err.name : "DataCloneError",
    });
  }
}

export function freezeSnapshotValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeSnapshotValue(child);
  return value;
}

export function batchSnapshot(snapshot, tx) {
  const view = tx.view({ includePlugins: true });
  const nodes = {};
  for (const [id, node] of Object.entries(view.nodes || {})) {
    nodes[id] = assignNodeRevision(snapshot && snapshot.revision, snapshot.nodes && snapshot.nodes[id], node).node;
  }
  const current = {
    ...snapshot,
    nodes,
    edges: view.edges,
    initiatives: view.initiatives,
  };
  if (Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(view.plugins || {}).length > 0) {
    current.plugins = view.plugins || {};
  } else {
    delete current.plugins;
  }
  return freezeSnapshotValue(current);
}

export function batchOperationError(index, op, err) {
  const cause = {
    code: err && typeof err.code === "string" ? err.code : "BATCH_OPERATION_FAILED",
    message: err && typeof err.message === "string" ? err.message : String(err),
  };
  if (err && err.details !== undefined) cause.details = cloneBatchValue(err.details);
  const wrapped = new Error(`core.batch: operation ${index} (${op}) failed: ${cause.message}`);
  wrapped.code = "BATCH_OPERATION_FAILED";
  wrapped.details = { operation_index: index, op, cause };
  return wrapped;
}

export function validateBatchOperation(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}] must be an object`, { field: `operations[${index}]` });
  }
  if (typeof raw.op !== "string" || raw.op.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}].op is required`, { field: `operations[${index}].op` });
  }
  if (!raw.input || typeof raw.input !== "object" || Array.isArray(raw.input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}].input must be an object`, { field: `operations[${index}].input` });
  }
  for (const key of ["actor", "pluginId", "plugin_id", "handler", "argv", "as", "_as"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}].${key} is not allowed`, { field: `operations[${index}].${key}` });
    }
    if (Object.prototype.hasOwnProperty.call(raw.input, key)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}].input.${key} is not allowed`, { field: `operations[${index}].input.${key}` });
    }
  }
  return { op: raw.op, input: cloneBatchValue(raw.input) };
}

export async function readMutationStateUnderLock(lockContext, projectDir) {
  let raw = null;
  try { raw = await fs.readFile(stateFile(projectDir), "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const statePath = stateFile(projectDir);
  const hasLedger = await fs.access(statePath.slice(0, statePath.lastIndexOf("/")) + "/revision-ledger.json").then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (hasLedger && raw !== null) {
    try { JSON.parse(raw); } catch {
      const error = new Error(`state: file at ${statePath} is corrupt or not valid JSON`);
      error.code = "CLIMIER_CORRUPT_STATE";
      throw error;
    }
  }
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed && typeof parsed === "object" && (parsed.version === 1 || parsed.version > 5)) {
      try {
        await readState(projectDir);
      } catch (error) {
        if (error.code === "STATE_V1_UNSUPPORTED" || error.code === "CLIMIER_INCOMPATIBLE_VERSION") throw error;
      }
    }
  }
  if (hasLedger && raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed === null) return null;
  }
  try {
    return await readFencedStateUnderLock(lockContext, { projectDir });
  } catch (error) {
    if (error.code !== "CLIMIER_UNSUPPORTED_SOURCE_VERSION") throw error;
    try {
      await readState(projectDir);
    } catch (stateError) {
      if (stateError.code === "STATE_V1_UNSUPPORTED" || stateError.code === "CLIMIER_INCOMPATIBLE_VERSION") {
        throw stateError;
      }
    }
    throw error;
  }
}
