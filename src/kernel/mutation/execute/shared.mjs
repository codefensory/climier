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

function isValidStateOperation(stateOperation) {
  return stateOperation && typeof stateOperation === "object" &&
    typeof stateOperation.prepare === "function" && typeof stateOperation.apply === "function";
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
  if (stateOperation !== undefined && !isValidStateOperation(stateOperation)) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      "kernel.mutate: stateOperation must provide prepare and apply",
      { field: "stateOperation" },
    );
  }
  if (stateOperation === undefined) {
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
    if (key === "target") {
      continue;
    }
    frozenExtras[key] = (value && typeof value === "object") ? Object.freeze(value) : value;
  }
  return Object.freeze({ ...frozenExtras, target: plan.target });
}

function policyContext(policyAction, request) {
  return {
    action: typeof policyAction.action === "string" && policyAction.action.length > 0
      ? policyAction.action
      : request.action,
    actor: typeof request.actor === "string" ? request.actor : "",
    pluginId: policyAction.pluginId || null,
  };
}

function isPolicyError(error) {
  return error && typeof error.code === "string" && error.code.startsWith("POLICY_") && error.details !== undefined;
}

function throwPolicyFailure(error, action, commandName) {
  if (isPolicyError(error)) {
    throw error;
  }
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${commandName}: policyAction.decide threw: ${error && error.message ? error.message : String(error)}`,
    { action, cause: error && error.code ? error.code : null },
  );
}

async function decidePolicy({ policyAction, policySnapshot, plan, request, action, commandName }) {
  try {
    return await policyAction.decide({ snapshot: policySnapshot, target: plan.target, request, action });
  } catch (error) {
    throwPolicyFailure(error, action, commandName);
  }
}

function validatePolicyDecision(decision, commandName) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: policyAction.decide must return an object`, { field: "policyAction" });
  }
}

function throwPolicyDenied({ decision, action, actor, pluginId, commandName }) {
  const reason = typeof decision.reason === "string" ? decision.reason : "(no reason)";
  throwV2(
    "POLICY_DENIED",
    `${commandName}: action ${action} denied by policy for actor '${actor}': ${reason}`,
    { plugin_id: pluginId, policy_id: pluginId, action, actor, reason: typeof decision.reason === "string" ? decision.reason : null },
  );
}

function validatePolicyDecisionKind(decision, commandName) {
  if (decision.decision !== "allow" && decision.decision !== "abstain") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: policyAction.decide returned an unknown decision: ${JSON.stringify(decision.decision)}`,
      { field: "policyAction.decision", value: decision.decision },
    );
  }
}

function rejectPolicyDecision({ decision, action, actor, pluginId, commandName }) {
  validatePolicyDecision(decision, commandName);
  if (decision.decision === "deny") {
    throwPolicyDenied({ decision, action, actor, pluginId, commandName });
  }
  validatePolicyDecisionKind(decision, commandName);
}

export async function runPolicy({ policyAction, snapshot, plan, request, commandName }) {
  if (!policyAction || typeof policyAction !== "object" || typeof policyAction.decide !== "function") {
    return;
  }
  const context = policyContext(policyAction, request);
  const policySnapshot = { ...snapshot };
  delete policySnapshot.fence_generation;
  const decision = await decidePolicy({ policyAction, policySnapshot, plan, request, action: context.action, commandName });
  rejectPolicyDecision({ decision, ...context, commandName });
}

function cloneError(err) {
  return err && err.name ? err.name : "DataCloneError";
}

export function cloneBatchValue(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate(core.batch): result must be cloneable JSON data", {
      field: "batch.result",
      cause: cloneError(err),
    });
  }
}

export function freezeSnapshotValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freezeSnapshotValue(child);
  }
  return value;
}

function batchPlugins(snapshot, plugins) {
  const hasPlugins = Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(plugins || {}).length > 0;
  return hasPlugins ? { plugins: plugins || {} } : {};
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
    ...batchPlugins(snapshot, view.plugins),
  };
  return freezeSnapshotValue(current);
}

export function batchOperationError(index, op, err) {
  const cause = {
    code: err && typeof err.code === "string" ? err.code : "BATCH_OPERATION_FAILED",
    message: err && typeof err.message === "string" ? err.message : String(err),
  };
  if (err && err.details !== undefined) {
    cause.details = cloneBatchValue(err.details);
  }
  const wrapped = new Error(`core.batch: operation ${index} (${op}) failed: ${cause.message}`);
  wrapped.code = "BATCH_OPERATION_FAILED";
  wrapped.details = { operation_index: index, op, cause };
  return wrapped;
}

const batchDisallowedKeys = ["actor", "pluginId", "plugin_id", "handler", "argv", "as", "_as"];

function assertAllowedBatchKeys(value, prefix, index) {
  for (const key of batchDisallowedKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}]${prefix}.${key} is not allowed`, { field: `operations[${index}]${prefix}.${key}` });
    }
  }
}

function validateBatchOperationShape(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}] must be an object`, { field: `operations[${index}]` });
  }
}

function validateBatchOperationInput(raw, index) {
  if (!raw.input || typeof raw.input !== "object" || Array.isArray(raw.input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}].input must be an object`, { field: `operations[${index}].input` });
  }
}

export function validateBatchOperation(raw, index) {
  validateBatchOperationShape(raw, index);
  if (typeof raw.op !== "string" || raw.op.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `core.batch: operations[${index}].op is required`, { field: `operations[${index}].op` });
  }
  validateBatchOperationInput(raw, index);
  assertAllowedBatchKeys(raw, "", index);
  assertAllowedBatchKeys(raw.input, ".input", index);
  return { op: raw.op, input: cloneBatchValue(raw.input) };
}

async function readRawState(projectDir) {
  try {
    return await fs.readFile(stateFile(projectDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function hasRevisionLedger(statePath) {
  const directory = statePath.slice(0, statePath.lastIndexOf("/"));
  try {
    await fs.access(`${directory}/revision-ledger.json`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseStateRaw(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isInvalidStateJson(raw) {
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

function assertLedgerStateValid(raw, hasLedger, statePath) {
  if (!hasLedger || raw === null || !isInvalidStateJson(raw)) {
    return;
  }
  const error = new Error(`state: file at ${statePath} is corrupt or not valid JSON`);
  error.code = "CLIMIER_CORRUPT_STATE";
  throw error;
}

function hasIncompatibleVersion(raw) {
  const parsed = parseStateRaw(raw);
  return parsed && typeof parsed === "object" && (parsed.version === 1 || parsed.version > 5);
}

function isIncompatibleVersionError(error) {
  return error.code === "STATE_V1_UNSUPPORTED" || error.code === "CLIMIER_INCOMPATIBLE_VERSION";
}

async function validateStateVersion(raw, projectDir) {
  if (raw === null || !hasIncompatibleVersion(raw)) {
    return;
  }
  try {
    await readState(projectDir);
  } catch (error) {
    if (isIncompatibleVersionError(error)) {
      throw error;
    }
  }
}

async function validateRawState(raw, hasLedger, projectDir, statePath) {
  assertLedgerStateValid(raw, hasLedger, statePath);
  await validateStateVersion(raw, projectDir);
}

async function readFencedState(lockContext, projectDir) {
  try {
    return await readFencedStateUnderLock(lockContext, { projectDir });
  } catch (error) {
    if (error.code !== "CLIMIER_UNSUPPORTED_SOURCE_VERSION") {
      throw error;
    }
    try {
      await readState(projectDir);
    } catch (stateError) {
      if (isIncompatibleVersionError(stateError)) {
        throw stateError;
      }
    }
    throw error;
  }
}

export async function readMutationStateUnderLock(lockContext, projectDir) {
  const statePath = stateFile(projectDir);
  const raw = await readRawState(projectDir);
  const hasLedger = await hasRevisionLedger(statePath);
  await validateRawState(raw, hasLedger, projectDir, statePath);
  return readFencedState(lockContext, projectDir);
}
