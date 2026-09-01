// Mutation execution coordinator.
//
// The public kernel façade owns the lock and re-entrancy boundary. This module
// owns the complete mutation pipeline once the caller is inside that lock:
// state snapshot, provider preparation, preconditions, policy, transaction
// application, draft validation, diff/revisions, audit construction and the
// single atomic persistence step.

import fs from "node:fs/promises";
import { readState, writeState, stateFile, createSnapshot, emptyState } from "../../storage/state.mjs";
import { prepareLogEntry } from "../../storage/log.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { createTransaction } from "../transaction.mjs";
import {
  commandLabel,
  operationLabel,
  validatePlan,
  validateProvider,
  validateRequest,
} from "./request.mjs";
import { checkPrecondition, checkStateRevision, selectPrecondition } from "./preconditions.mjs";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  deepEqualNodes,
} from "./diff.mjs";
import { deriveTargetRevision, stripRevision } from "./revisions.mjs";
import { normalizeLogFields, validateDraftStructural } from "./validation.mjs";
import { buildLogEntry } from "./log-entry.mjs";

/**
 * Validate arguments accepted by kernel.mutate before execution begins.
 * Returns the operation label used in contract errors.
 */
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

/** Freeze a provider plan before policy and apply receive it. */
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

async function runPolicy(policyAction, snapshot, plan, request, commandName) {
  if (!policyAction || typeof policyAction !== "object" || typeof policyAction.decide !== "function") return;
  const action = typeof policyAction.action === "string" && policyAction.action.length > 0
    ? policyAction.action
    : request.action;
  const actor = typeof request.actor === "string" ? request.actor : "";
  const pluginId = policyAction.pluginId || null;
  let decision;
  try {
    decision = await policyAction.decide({ snapshot, target: plan.target, request, action });
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

function cloneBatchValue(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate(core.batch): result must be cloneable JSON data", {
      field: "batch.result",
      cause: err && err.name ? err.name : "DataCloneError",
    });
  }
}

function freezeSnapshotValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeSnapshotValue(child);
  return value;
}

function batchSnapshot(snapshot, tx) {
  const view = tx.view({ includePlugins: true });
  const nodes = {};
  for (const [id, node] of Object.entries(view.nodes || {})) {
    const previous = snapshot.nodes && snapshot.nodes[id];
    const copy = { ...node };
    if (!previous) {
      copy.revision = 1;
    } else if (deepEqualNodes(stripRevision(previous), node)) {
      copy.revision = Number.isInteger(previous.revision) ? previous.revision : 1;
    } else {
      copy.revision = (Number.isInteger(previous.revision) ? previous.revision : 0) + 1;
    }
    nodes[id] = copy;
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

function batchOperationError(index, op, err) {
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

function validateBatchOperation(raw, index) {
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

async function executeBatchMutation({ projectDir, request, batch, policyAction, pluginId }) {
  const commandName = "core.batch";
  const loadedState = await readState(projectDir);
  const snapshot = loadedState;
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 4) {
    throw new Error(`${commandName}: state file missing or not v4 (run init first)`);
  }
  checkStateRevision(request.if_state_revision, snapshot, commandName);
  const rawOperations = request.input && request.input.operations;
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: operations must be a non-empty array`, { field: "operations" });
  }
  const operations = [];
  for (let index = 0; index < rawOperations.length; index += 1) {
    try {
      operations.push(validateBatchOperation(rawOperations[index], index));
    } catch (err) {
      throw batchOperationError(index, rawOperations[index] && rawOperations[index].op, err);
    }
  }
  const tx = createTransaction(snapshot);
  const results = [];
  const plans = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    let plan;
    try {
      const operationSnapshot = batchSnapshot(snapshot, tx);
      const entry = batch.registry.lookup(operation.op);
      if (!entry || typeof entry !== "object") {
        const error = new Error(`core.batch: operation '${operation.op}' is not registered`);
        error.code = "OPERATION_NOT_FOUND";
        error.details = { operation: operation.op };
        throw error;
      }
      const provider = entry.provider || entry;
      validateProvider(provider);
      const operationRequest = { action: operation.op, actor: request.actor, input: operation.input };
      if (Object.prototype.hasOwnProperty.call(operation.input, "if_state_revision")) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: operation input cannot carry if_state_revision`, { field: `operations[${index}].input.if_state_revision` });
      }
      if (Object.prototype.hasOwnProperty.call(operation.input, "if_revision")) {
        operationRequest.if_revision = { kind: "single", id: operation.input.id, value: Number(operation.input.if_revision) };
      }
      if (operation.input.if_revisions && typeof operation.input.if_revisions === "object" && !Array.isArray(operation.input.if_revisions)) {
        operationRequest.if_revision = { kind: "multi", values: operation.input.if_revisions };
      }
      const prepared = await provider.prepare({ snapshot: operationSnapshot, input: operation.input, request: operationRequest, pluginId });
      plan = freezePlan(prepared, operationLabel(operationRequest));
      normalizeLogFields(plan.logFields, operationLabel(operationRequest));
      checkPrecondition(selectPrecondition(operationRequest, plan), operationSnapshot, operationLabel(operationRequest));
      await runPolicy(policyAction, operationSnapshot, plan, operationRequest, operationLabel(operationRequest));
      const before = operationSnapshot;
      const applied = await provider.apply({ tx, plan, input: operation.input, request: operationRequest, snapshot: before });
      let result = null;
      let effects = null;
      if (applied !== undefined && applied !== null) {
        if (typeof applied !== "object" || Array.isArray(applied)) {
          throwV2("INVALID_EXECUTION_CONTRACT", `${operationLabel(operationRequest)}: apply must return an object`, { field: "apply" });
        }
        if ("result" in applied) result = cloneBatchValue(applied.result);
        if ("effects" in applied) effects = applied.effects == null ? null : cloneBatchValue(applied.effects);
      }
      const after = batchSnapshot(snapshot, tx);
      const changed = !deepEqualNodes(
        { nodes: before.nodes, edges: before.edges, initiatives: before.initiatives, plugins: before.plugins || {} },
        { nodes: after.nodes, edges: after.edges, initiatives: after.initiatives, plugins: after.plugins || {} },
      );
      plans.push(plan);
      results.push({ op: operation.op, result, effects, idempotent: !changed });
    } catch (err) {
      throw batchOperationError(index, operation.op, err);
    }
  }

  const draftView = tx.view({ includePlugins: true });
  validateDraftStructural(draftView, commandName);
  const { next: nextNodes, removed: removedNodes, created, updated } = assignRevisionsAndDiff(snapshot, draftView);
  const { added: addedEdges, removed: removedEdges } = computeEdgeDiff(snapshot.edges || [], draftView.edges || []);
  const initiativeDiff = computeInitiativeDiff(snapshot.initiatives || {}, draftView.initiatives || {});
  const pluginsBefore = snapshot.plugins && typeof snapshot.plugins === "object" && !Array.isArray(snapshot.plugins) ? snapshot.plugins : {};
  const pluginsAfter = draftView.plugins && typeof draftView.plugins === "object" && !Array.isArray(draftView.plugins) ? draftView.plugins : {};
  const pluginsChanged = !deepEqualNodes(pluginsBefore, pluginsAfter);
  const changed = created.length > 0 || updated.length > 0 || addedEdges.length > 0 || removedEdges.length > 0 || removedNodes.length > 0 || initiativeDiff.created.length > 0 || initiativeDiff.updated.length > 0 || pluginsChanged;
  const revisionBefore = snapshot.revision;
  const revisionAfter = changed ? revisionBefore + 1 : revisionBefore;
  if (changed) {
    const finalNodes = {};
    for (const [id, node] of Object.entries(nextNodes)) finalNodes[id] = node;
    const finalInitiatives = {};
    for (const [name, init] of Object.entries(draftView.initiatives || {})) finalInitiatives[name] = init;
    const logOperations = results.map((entry, index) => ({
      index,
      op: entry.op,
      target: plans[index] && plans[index].target ? plans[index].target.id : null,
      idempotent: entry.idempotent,
    }));
    const logEntry = prepareLogEntry({ action: commandName, agent: request.actor, revision: revisionAfter, operations: logOperations }, { pluginId });
    const persistedState = {
      ...snapshot,
      nodes: finalNodes,
      edges: draftView.edges,
      initiatives: finalInitiatives,
      log: [...(Array.isArray(snapshot.log) ? snapshot.log : []), logEntry],
      revision: revisionAfter,
    };
    if (Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(pluginsAfter).length > 0) persistedState.plugins = pluginsAfter;
    else delete persistedState.plugins;
    await writeState(projectDir, persistedState);
  }
  return { ok: true, revision_before: revisionBefore, revision_after: revisionAfter, results };
}

async function executeStateMutation({ projectDir, request, stateOperation, policyAction, pluginId }) {
  const commandName = commandLabel(request);
  const statePath = stateFile(projectDir);
  let currentRaw = null;
  let currentState = null;
  let exists = false;
  try {
    currentRaw = await fs.readFile(statePath);
    exists = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let stateError = null;
  if (exists) {
    try {
      currentState = await readState(projectDir);
    } catch (err) {
      if (!["CLIMIER_CORRUPT_STATE", "STATE_V1_UNSUPPORTED", "CLIMIER_INCOMPATIBLE_VERSION"].includes(err.code)) throw err;
      stateError = err;
    }
  }
  const snapshot = Object.freeze({
    state: currentState,
    raw: currentRaw,
    exists,
    stateError,
    nodes: currentState && currentState.nodes ? { ...currentState.nodes } : {},
    edges: currentState && Array.isArray(currentState.edges) ? currentState.edges.slice() : [],
    initiatives: currentState && currentState.initiatives ? { ...currentState.initiatives } : {},
    ...(currentState && Object.prototype.hasOwnProperty.call(currentState, "plugins")
      ? { plugins: currentState.plugins }
      : {}),
    revision: currentState && Number.isInteger(currentState.revision) ? currentState.revision : 0,
  });
  const prepared = await stateOperation.prepare({ projectDir, snapshot, input: request.input, request });
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || !prepared.target || typeof prepared.target.id !== "string") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation prepare must return a plan with target`, { field: "plan" });
  }
  const plan = Object.freeze({ ...prepared, target: Object.freeze({ ...prepared.target }) });
  checkStateRevision(request.if_state_revision, snapshot, commandName);
  await runPolicy(policyAction, snapshot, plan, request, commandName);
  const applied = await stateOperation.apply({ snapshot, plan, input: request.input, request });
  if (!applied || typeof applied !== "object" || !applied.state || typeof applied.state !== "object" || Array.isArray(applied.state)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation apply must return a state object`, { field: "state" });
  }
  let snapshotMeta = null;
  if (plan.snapshotReason) {
    if (!exists) throwV2("INVALID_STATUS", `${commandName}: cannot snapshot a missing current state`, { state_file: statePath });
    snapshotMeta = await createSnapshot(projectDir, plan.snapshotReason);
  }
  const nextState = {
    ...applied.state,
    revision: currentState ? snapshot.revision + 1 : applied.state.revision,
  };
  let logEntry = null;
  if (plan.log) {
    logEntry = prepareLogEntry({ action: plan.logAction || request.action, agent: request.actor, ...plan.log }, { pluginId });
    nextState.log = [...(Array.isArray(nextState.log) ? nextState.log : []), logEntry];
  }
  await writeState(projectDir, nextState);
  let result = applied.result === undefined ? null : applied.result;
  if (snapshotMeta && result && typeof result === "object" && !Array.isArray(result) && result.snapshot === undefined) {
    result = { ...result, snapshot: snapshotMeta };
  }
  return {
    result,
    effects: applied.effects === undefined ? null : applied.effects,
    log_entry: logEntry,
    idempotent: false,
    diff: { created: [], updated: [], added_edges: [], removed_edges: [], removed_nodes: [], target_revision: null, initiatives: { created: [], updated: [] } },
  };
}

/**
 * Run the complete mutation pipeline. The caller must hold the project lock.
 * This function intentionally performs no lock acquisition so all reads,
 * provider callbacks and the final atomic write share the façade's lock.
 */
export async function executeMutation({ projectDir, request, provider, policyAction, pluginId, stateOperation, batch }) {
  const commandName = validateMutationArguments({ request, provider, stateOperation, batch });
  if (batch !== undefined) {
    return executeBatchMutation({ projectDir, request, batch, policyAction, pluginId });
  }
  if (stateOperation !== undefined) {
    return executeStateMutation({ projectDir, request, stateOperation, policyAction, pluginId });
  }

  const loadedState = await readState(projectDir);
  const mayBootstrap = loadedState === null && request.action === "initiative.create" && provider.bootstrapMissingState === true;
  const snapshot = loadedState ?? (mayBootstrap ? emptyState() : null);
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 4) {
    throw new Error(`${commandName}: state file missing or not v4 (run init first)`);
  }

  // 1) Prepare once against the fresh snapshot, while the lock is held.
  const prepareResult = await provider.prepare({ snapshot, input: request.input, request, pluginId });
  const frozenPlan = freezePlan(prepareResult, commandName);
  normalizeLogFields(frozenPlan.logFields, commandName);

  // 2) Validate caller/provider CAS before policy and apply.
  checkStateRevision(request.if_state_revision, snapshot, commandName);
  const precondition = selectPrecondition(request, frozenPlan);
  checkPrecondition(precondition, snapshot, commandName);

  // 3) Authorize against the same fresh snapshot and plan.
  await runPolicy(policyAction, snapshot, frozenPlan, request, commandName);

  // 4) Apply only to a transaction draft.
  const tx = createTransaction(snapshot);
  const applyResult = await provider.apply({ tx, plan: frozenPlan, input: request.input, request, snapshot });
  let result = null;
  let effects = null;
  if (applyResult !== undefined && applyResult !== null) {
    if (typeof applyResult !== "object" || Array.isArray(applyResult)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: apply must return an object`, { field: "apply" });
    }
    if ("result" in applyResult) result = applyResult.result;
    if ("effects" in applyResult) {
      if (applyResult.effects !== undefined && applyResult.effects !== null && (typeof applyResult.effects !== "object" || Array.isArray(applyResult.effects))) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: apply.effects must be an object when present`, { field: "effects" });
      }
      effects = applyResult.effects === null ? null : applyResult.effects;
    }
  }

  // 5) Validate, diff, assign revisions and persist one atomic state+log.
  const draftView = tx.view({ includePlugins: true });
  validateDraftStructural(draftView, commandName);
  const { next: nextNodes, removed: removedNodes, created, updated } = assignRevisionsAndDiff(snapshot, draftView);
  const { added: addedEdges, removed: removedEdges } = computeEdgeDiff(snapshot.edges || [], draftView.edges || []);
  const initiativeDiff = computeInitiativeDiff(snapshot.initiatives || {}, draftView.initiatives || {});
  const pluginsBefore = snapshot.plugins && typeof snapshot.plugins === "object" && !Array.isArray(snapshot.plugins) ? snapshot.plugins : {};
  const pluginsAfter = draftView.plugins && typeof draftView.plugins === "object" && !Array.isArray(draftView.plugins) ? draftView.plugins : {};
  const pluginsChanged = !deepEqualNodes(pluginsBefore, pluginsAfter);
  const isIdempotent = created.length === 0 && updated.length === 0 && addedEdges.length === 0 && removedEdges.length === 0 &&
    removedNodes.length === 0 && initiativeDiff.created.length === 0 && initiativeDiff.updated.length === 0 && !pluginsChanged;

  let logEntry = null;
  if (!isIdempotent) {
    const targetNextRevision = deriveTargetRevision(snapshot, frozenPlan, created, updated);
    const finalNodes = {};
    for (const [id, node] of Object.entries(snapshot.nodes || {})) {
      if (Object.prototype.hasOwnProperty.call(nextNodes, id)) finalNodes[id] = nextNodes[id];
    }
    for (const [id, node] of Object.entries(nextNodes)) {
      if (!Object.prototype.hasOwnProperty.call(finalNodes, id)) finalNodes[id] = node;
    }
    const snapInits = snapshot.initiatives && typeof snapshot.initiatives === "object" ? snapshot.initiatives : {};
    const draftInits = draftView.initiatives || {};
    const finalInitiatives = {};
    for (const [name, init] of Object.entries(snapInits)) {
      finalInitiatives[name] = Object.prototype.hasOwnProperty.call(draftInits, name) ? draftInits[name] : init;
    }
    for (const [name, init] of Object.entries(draftInits)) {
      if (!Object.prototype.hasOwnProperty.call(finalInitiatives, name)) finalInitiatives[name] = init;
    }
    const logPayload = buildLogEntry(
      request, frozenPlan, created, updated, addedEdges, removedEdges, removedNodes,
      targetNextRevision, pluginId, initiativeDiff,
    );
    const persistedState = {
      ...snapshot,
      nodes: finalNodes,
      edges: draftView.edges,
      initiatives: finalInitiatives,
      log: [...(Array.isArray(snapshot.log) ? snapshot.log : []), logPayload],
      revision: snapshot.revision + 1,
    };
    if (Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(pluginsAfter).length > 0) {
      persistedState.plugins = pluginsAfter;
    } else {
      delete persistedState.plugins;
    }
    logEntry = logPayload;
    await writeState(projectDir, persistedState);
  }

  return {
    result,
    effects,
    log_entry: logEntry,
    idempotent: isIdempotent,
    diff: {
      created,
      updated,
      added_edges: addedEdges,
      removed_edges: removedEdges,
      removed_nodes: removedNodes,
      target_revision: deriveTargetRevision(snapshot, frozenPlan, created, updated),
      initiatives: initiativeDiff,
    },
  };
}

// Compatibility aliases retained for callers that imported the coordinator
// helpers before executeMutation became the pipeline boundary.
export { commandLabel, operationLabel, executeBatchMutation };
