

import { commitFencedStateUnderLock } from "../../../storage/ledger.mjs";
import { isFencedStateVersion } from "../../../storage/state.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";
import { prepareLogEntry } from "../../../storage/log.mjs";
import { createTransaction } from "../../transaction.mjs";
import {
  batchOperationError,
  batchSnapshot,
  checkStateRevision,
  checkPrecondition,
  selectPrecondition,
  validateProvider,
  cloneBatchValue,
  normalizeLogFields,
  operationLabel,
  readMutationStateUnderLock,
  runPolicy,
  validateBatchOperation,
  freezePlan,
} from "./shared.mjs";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  deepEqualNodes,
} from "../diff.mjs";
import { deriveNextStateRevision } from "../revisions.mjs";
import { validateDraftStructural } from "../validation.mjs";

function validateOperations(rawOperations) {
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", "core.batch: operations must be a non-empty array", { field: "operations" });
  }
  const operations = [];
  for (let index = 0; index < rawOperations.length; index += 1) {
    try {
      operations.push(validateBatchOperation(rawOperations[index], index));
    } catch (err) {
      throw batchOperationError(index, rawOperations[index] && rawOperations[index].op, err);
    }
  }
  return operations;
}

function makeOperationRequest(operation, request, index, commandName) {
  const operationRequest = { action: operation.op, actor: request.actor, input: operation.input };
  if (Object.prototype.hasOwnProperty.call(operation.input, "if_state_revision")) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: operation input cannot carry if_state_revision`, { field: `operations[${index}].input.if_state_revision` });
  }
  assignOperationRevision(operation.input, operationRequest);
  assignOperationRevisions(operation.input, operationRequest);
  return operationRequest;
}

function assignOperationRevision(input, operationRequest) {
  if (!Object.prototype.hasOwnProperty.call(input, "if_revision")) {
    return;
  }
  operationRequest.if_revision = { kind: "single", id: input.id, value: Number(input.if_revision) };
}

function assignOperationRevisions(input, operationRequest) {
  const revisions = input.if_revisions;
  if (revisions && typeof revisions === "object" && !Array.isArray(revisions)) {
    operationRequest.if_revision = { kind: "multi", values: revisions };
  }
}

function operationEntry(registry, operation) {
  const entry = registry.lookup(operation.op);
  if (!entry || typeof entry !== "object") {
    const error = new Error(`core.batch: operation '${operation.op}' is not registered`);
    error.code = "OPERATION_NOT_FOUND";
    error.details = { operation: operation.op };
    throw error;
  }
  const provider = entry.provider || entry;
  validateProvider(provider);
  return provider;
}

function readApplyResult(applied, operationRequest) {
  if (applied === undefined || applied === null) {
    return { result: null, effects: null };
  }
  if (typeof applied !== "object" || Array.isArray(applied)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${operationLabel(operationRequest)}: apply must return an object`, { field: "apply" });
  }
  return { result: cloneResult(applied), effects: cloneEffects(applied) };
}

function cloneResult(applied) {
  return "result" in applied ? cloneBatchValue(applied.result) : null;
}

function cloneEffects(applied) {
  return "effects" in applied && applied.effects !== null && applied.effects !== undefined ? cloneBatchValue(applied.effects) : null;
}

async function executeOperation({ operation, index, request, batch, policyAction, pluginId, tx, snapshot, results, plans }) {
  try {
    const operationSnapshot = batchSnapshot(snapshot, tx);
    const provider = operationEntry(batch.registry, operation);
    const operationRequest = makeOperationRequest(operation, request, index, "core.batch");
    const commandName = operationLabel(operationRequest);
    const prepared = await provider.prepare({ snapshot: operationSnapshot, input: operation.input, request: operationRequest, pluginId });
    const plan = freezePlan(prepared, commandName);
    normalizeLogFields(plan.logFields, commandName);
    checkPrecondition(selectPrecondition(operationRequest, plan), operationSnapshot, commandName);
    await runPolicy({ policyAction, snapshot: operationSnapshot, plan, request: operationRequest, commandName });
    const applied = await provider.apply({ tx, plan, input: operation.input, request: operationRequest, snapshot: operationSnapshot });
    const outcome = readApplyResult(applied, operationRequest);
    const after = batchSnapshot(snapshot, tx);
    const changed = !deepEqualNodes(
      { nodes: operationSnapshot.nodes, edges: operationSnapshot.edges, initiatives: operationSnapshot.initiatives, plugins: operationSnapshot.plugins || {} },
      { nodes: after.nodes, edges: after.edges, initiatives: after.initiatives, plugins: after.plugins || {} },
    );
    plans.push(plan);
    results.push({ op: operation.op, ...outcome, idempotent: !changed });
  } catch (err) {
    throw batchOperationError(index, operation.op, err);
  }
}

async function executeOperations({ operations, request, batch, policyAction, pluginId, tx, snapshot }) {
  const results = [];
  const plans = [];
  for (let index = 0; index < operations.length; index += 1) {
    await executeOperation({ operation: operations[index], index, request, batch, policyAction, pluginId, tx, snapshot, results, plans });
  }
  return { results, plans };
}

function normalizePluginState(plugins) {
  return plugins && typeof plugins === "object" && !Array.isArray(plugins) ? plugins : {};
}

function pluginChanges(snapshot, draftView) {
  const before = normalizePluginState(snapshot.plugins);
  const after = normalizePluginState(draftView.plugins);
  return { pluginsAfter: after, pluginsChanged: !deepEqualNodes(before, after) };
}

function entityChanges(diff, initiativeDiff, pluginsChanged) {
  return diff.created.length > 0 || diff.updated.length > 0 || diff.addedEdges.length > 0 || diff.removedEdges.length > 0 ||
    diff.removedNodes.length > 0 || initiativeDiff.created.length > 0 || initiativeDiff.updated.length > 0 || pluginsChanged;
}

function diffBatch(snapshot, draftView) {
  const nodeDiff = assignRevisionsAndDiff(snapshot, draftView);
  const edgeDiff = computeEdgeDiff(snapshot.edges || [], draftView.edges || []);
  const initiativeDiff = computeInitiativeDiff(snapshot.initiatives || {}, draftView.initiatives || {});
  const { pluginsAfter, pluginsChanged } = pluginChanges(snapshot, draftView);
  const diff = {
    nextNodes: nodeDiff.next,
    removedNodes: nodeDiff.removed,
    created: nodeDiff.created,
    updated: nodeDiff.updated,
    addedEdges: edgeDiff.added,
    removedEdges: edgeDiff.removed,
  };
  return { ...diff, initiativeDiff, pluginsAfter, changed: entityChanges(diff, initiativeDiff, pluginsChanged) };
}

function buildPersistedBatchState({ snapshot, draftView, diff, results, plans, request, pluginId, revisionAfter }) {
  const finalNodes = {};
  for (const [id, node] of Object.entries(diff.nextNodes)) {
    finalNodes[id] = node;
  }
  const finalInitiatives = {};
  for (const [name, init] of Object.entries(draftView.initiatives || {})) {
    finalInitiatives[name] = init;
  }
  const logOperations = results.map((entry, index) => ({
    index,
    op: entry.op,
    target: plans[index] && plans[index].target ? plans[index].target.id : null,
    idempotent: entry.idempotent,
  }));
  const logEntry = prepareLogEntry({ action: "core.batch", agent: request.actor, revision: revisionAfter, operations: logOperations }, { pluginId });
  const persistedState = {
    ...snapshot,
    fence_generation: snapshot.fence_generation,
    nodes: finalNodes,
    edges: draftView.edges,
    initiatives: finalInitiatives,
    log: [...(Array.isArray(snapshot.log) ? snapshot.log : []), logEntry],
    revision: revisionAfter,
  };
  const hasPlugins = Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(diff.pluginsAfter).length > 0;
  if (hasPlugins) {
    persistedState.plugins = diff.pluginsAfter;
  } else {
    delete persistedState.plugins;
  }
  return persistedState;
}

export async function executeBatchMutation({ projectDir, lockContext, request, batch, policyAction, pluginId }) {
  const commandName = "core.batch";
  const snapshot = await readMutationStateUnderLock(lockContext, projectDir);
  if (!snapshot || typeof snapshot !== "object" || !isFencedStateVersion(snapshot.version)) {
    throw new Error(`${commandName}: state file missing or not canonical (run init first)`);
  }
  checkStateRevision(request.if_state_revision, snapshot, commandName);
  const operations = validateOperations(request.input && request.input.operations);
  const tx = createTransaction(snapshot);
  const { results, plans } = await executeOperations({ operations, request, batch, policyAction, pluginId, tx, snapshot });
  const draftView = tx.view({ includePlugins: true });
  validateDraftStructural(draftView, commandName);
  const diff = diffBatch(snapshot, draftView);
  const revisionBefore = snapshot.revision;
  const revisionAfter = diff.changed ? deriveNextStateRevision(snapshot, diff.nextNodes) : snapshot.revision;
  if (diff.changed) {
    const persistedState = buildPersistedBatchState({ snapshot, draftView, diff, results, plans, request, pluginId, revisionAfter });
    await commitFencedStateUnderLock(lockContext, persistedState);
  }
  return { ok: true, revision_before: revisionBefore, revision_after: revisionAfter, results };
}
