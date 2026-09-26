// Batch mutation phase for the kernel execution coordinator.

import { commitFencedStateUnderLock } from "../../../storage/ledger.mjs";
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

export async function executeBatchMutation({ projectDir, lockContext, request, batch, policyAction, pluginId }) {
  const commandName = "core.batch";
  const loadedState = await readMutationStateUnderLock(lockContext, projectDir);
  const snapshot = loadedState;
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 5) {
    throw new Error(`${commandName}: state file missing or not v5 (run init first)`);
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
  const revisionAfter = changed ? deriveNextStateRevision(snapshot, nextNodes) : snapshot.revision;
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
      version: 5,
      fence_generation: snapshot.fence_generation,
      nodes: finalNodes,
      edges: draftView.edges,
      initiatives: finalInitiatives,
      log: [...(Array.isArray(snapshot.log) ? snapshot.log : []), logEntry],
      revision: revisionAfter,
    };
    if (Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(pluginsAfter).length > 0) persistedState.plugins = pluginsAfter;
    else delete persistedState.plugins;
    await commitFencedStateUnderLock(lockContext, persistedState);
  }
  return { ok: true, revision_before: revisionBefore, revision_after: revisionAfter, results };
}
