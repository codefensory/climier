// Provider mutation phase for the kernel execution coordinator.

import { emptyState } from "../../../storage/state.mjs";
import { bootstrapFencedStateUnderLock, commitFencedStateUnderLock } from "../../../storage/ledger.mjs";
import { createTransaction } from "../../transaction.mjs";
import {
  buildLogEntry,
} from "../log-entry.mjs";
import {
  checkStateRevision,
  freezePlan,
  readMutationStateUnderLock,
  runPolicy,
  checkPrecondition,
  selectPrecondition,
} from "./shared.mjs";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  deepEqualNodes,
} from "../diff.mjs";
import { deriveNextStateRevision, deriveTargetRevision } from "../revisions.mjs";
import { normalizeLogFields, validateDraftStructural } from "../validation.mjs";

export async function executeProviderMutation({ projectDir, lockContext, request, provider, policyAction, pluginId, commandName }) {
  const loadedState = await readMutationStateUnderLock(lockContext, projectDir);
  const mayBootstrap = loadedState === null && request.action === "initiative.create" && provider.bootstrapMissingState === true;
  let snapshot = loadedState ?? (mayBootstrap ? { ...emptyState(), version: 5, fence_generation: 1 } : null);
  if ((!snapshot || typeof snapshot !== "object" || snapshot.version !== 5) && !mayBootstrap) {
    throw new Error(`${commandName}: state file missing or not v5 (run init first)`);
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
  const isIdempotent = !mayBootstrap && created.length === 0 && updated.length === 0 && addedEdges.length === 0 && removedEdges.length === 0 &&
    removedNodes.length === 0 && initiativeDiff.created.length === 0 && initiativeDiff.updated.length === 0 && !pluginsChanged;

  let logEntry = null;
  if (!isIdempotent) {
    const targetNextRevision = deriveTargetRevision(snapshot, frozenPlan, created, updated);
    const finalNodes = {};
    for (const [id, _node] of Object.entries(snapshot.nodes || {})) {
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
      version: 5,
      fence_generation: snapshot.fence_generation,
      nodes: finalNodes,
      edges: draftView.edges,
      initiatives: finalInitiatives,
      log: [...(Array.isArray(snapshot.log) ? snapshot.log : []), logPayload],
      revision: deriveNextStateRevision(snapshot, nextNodes),
    };
    if (Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(pluginsAfter).length > 0) {
      persistedState.plugins = pluginsAfter;
    } else {
      delete persistedState.plugins;
    }
    logEntry = logPayload;
    if (mayBootstrap) {
      const bootstrapState = {
        ...persistedState,
        version: 4,
        revision: Math.max(0, ...Object.values(persistedState.nodes).map((node) => Number.isInteger(node.revision) ? node.revision : 0)),
      };
      delete bootstrapState.fence_generation;
      await bootstrapFencedStateUnderLock(lockContext, bootstrapState);
    } else {
      await commitFencedStateUnderLock(lockContext, persistedState);
    }
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
