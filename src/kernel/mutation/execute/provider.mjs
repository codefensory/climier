

import { emptyState, isFencedStateVersion } from "../../../storage/state.mjs";
import { bootstrapFencedStateUnderLock, commitFencedStateUnderLock } from "../../../storage/ledger.mjs";
import { createTransaction } from "../../transaction.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";
import { buildLogEntry } from "../log-entry.mjs";
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

function isBootstrapAllowed(loadedState, request, provider) {
  return loadedState === null && request.action === "initiative.create" && provider.bootstrapMissingState === true;
}

function validateLoadedSnapshot(snapshot, mayBootstrap, commandName) {
  const invalidSnapshot = !snapshot || typeof snapshot !== "object" || !isFencedStateVersion(snapshot.version);
  if (invalidSnapshot && !mayBootstrap) {
    throw new Error(`${commandName}: state file missing or not canonical (run init first)`);
  }
}

function initialSnapshot(loadedState, request, provider, commandName) {
  const mayBootstrap = isBootstrapAllowed(loadedState, request, provider);
  const snapshot = loadedState ?? (mayBootstrap ? emptyState() : null);
  validateLoadedSnapshot(snapshot, mayBootstrap, commandName);
  return { snapshot, mayBootstrap };
}

async function prepareMutationPlan({ provider, snapshot, request, pluginId, commandName }) {
  const prepareResult = await provider.prepare({ snapshot, input: request.input, request, pluginId });
  const plan = freezePlan(prepareResult, commandName);
  normalizeLogFields(plan.logFields, commandName);
  checkStateRevision(request.if_state_revision, snapshot, commandName);
  checkPrecondition(selectPrecondition(request, plan), snapshot, commandName);
  return plan;
}

function validateApplyResult(applyResult, commandName) {
  if (typeof applyResult !== "object" || Array.isArray(applyResult)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: apply must return an object`, { field: "apply" });
  }
}

function extractApplyResult(applyResult) {
  return "result" in applyResult ? applyResult.result : null;
}

function extractApplyEffects(applyResult, commandName) {
  if (!("effects" in applyResult)) {
    return null;
  }
  const effectValue = applyResult.effects;
  const invalidEffects = effectValue !== undefined && effectValue !== null && (typeof effectValue !== "object" || Array.isArray(effectValue));
  if (invalidEffects) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: apply.effects must be an object when present`, { field: "effects" });
  }
  return effectValue === null ? null : effectValue;
}

function normalizeApplyResult(applyResult, commandName) {
  if (applyResult === undefined || applyResult === null) {
    return { result: null, effects: null };
  }
  validateApplyResult(applyResult, commandName);
  return { result: extractApplyResult(applyResult), effects: extractApplyEffects(applyResult, commandName) };
}

function normalizePlugins(plugins) {
  return plugins && typeof plugins === "object" && !Array.isArray(plugins) ? plugins : {};
}

function hasStructuralChanges({ created, updated, addedEdges, removedEdges, removedNodes, initiativeDiff }) {
  return created.length > 0 || updated.length > 0 || addedEdges.length > 0 || removedEdges.length > 0 || removedNodes.length > 0 ||
    initiativeDiff.created.length > 0 || initiativeDiff.updated.length > 0;
}

function computeMutationDiff(snapshot, draftView) {
  const { next: nextNodes, removed: removedNodes, created, updated } = assignRevisionsAndDiff(snapshot, draftView);
  const { added: addedEdges, removed: removedEdges } = computeEdgeDiff(snapshot.edges || [], draftView.edges || []);
  const initiativeDiff = computeInitiativeDiff(snapshot.initiatives || {}, draftView.initiatives || {});
  const pluginsBefore = normalizePlugins(snapshot.plugins);
  const pluginsAfter = normalizePlugins(draftView.plugins);
  const pluginsChanged = !deepEqualNodes(pluginsBefore, pluginsAfter);
  const changes = { created, updated, addedEdges, removedEdges, removedNodes, initiativeDiff };
  const isIdempotent = !hasStructuralChanges(changes) && !pluginsChanged;
  return { nextNodes, removedNodes, created, updated, addedEdges, removedEdges, initiativeDiff, pluginsAfter, isIdempotent };
}

function finalNodesForSnapshot(snapshot, nextNodes) {
  const finalNodes = {};
  for (const id of Object.keys(snapshot.nodes || {})) {
    if (Object.prototype.hasOwnProperty.call(nextNodes, id)) {
      finalNodes[id] = nextNodes[id];
    }
  }
  for (const [id, node] of Object.entries(nextNodes)) {
    if (!Object.prototype.hasOwnProperty.call(finalNodes, id)) {
      finalNodes[id] = node;
    }
  }
  return finalNodes;
}

function finalInitiativesForSnapshot(snapshot, draftInitiatives) {
  const snapshotInitiatives = snapshot.initiatives && typeof snapshot.initiatives === "object" ? snapshot.initiatives : {};
  const draftInits = draftInitiatives || {};
  const finalInitiatives = {};
  for (const [name, init] of Object.entries(snapshotInitiatives)) {
    finalInitiatives[name] = Object.prototype.hasOwnProperty.call(draftInits, name) ? draftInits[name] : init;
  }
  for (const [name, init] of Object.entries(draftInits)) {
    if (!Object.prototype.hasOwnProperty.call(finalInitiatives, name)) {
      finalInitiatives[name] = init;
    }
  }
  return finalInitiatives;
}

function createPersistedState({ snapshot, draftView, diff, request, pluginId, targetNextRevision }) {
  const logEntry = buildLogEntry(
    request, diff.plan, diff.created, diff.updated, diff.addedEdges, diff.removedEdges, diff.removedNodes,
    targetNextRevision, pluginId, diff.initiativeDiff,
  );
  const persistedState = {
    ...snapshot,
    version: snapshot.version,
    fence_generation: snapshot.fence_generation,
    nodes: finalNodesForSnapshot(snapshot, diff.nextNodes),
    edges: draftView.edges,
    initiatives: finalInitiativesForSnapshot(snapshot, draftView.initiatives),
    log: [...(Array.isArray(snapshot.log) ? snapshot.log : []), logEntry],
    revision: deriveNextStateRevision(snapshot, diff.nextNodes),
  };
  if (Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(diff.pluginsAfter).length > 0) {
    persistedState.plugins = diff.pluginsAfter;
  } else {
    delete persistedState.plugins;
  }
  return { persistedState, logEntry };
}

async function persistMutation({ mayBootstrap, lockContext, persistedState }) {
  if (mayBootstrap) {
    await bootstrapFencedStateUnderLock(lockContext, persistedState);
    return;
  }
  await commitFencedStateUnderLock(lockContext, persistedState);
}

async function commitMutation({ snapshot, draftView, diff, request, pluginId, lockContext, mayBootstrap, plan }) {
  const targetNextRevision = deriveTargetRevision(snapshot, plan, diff.created, diff.updated);
  const { persistedState, logEntry } = createPersistedState({
    snapshot,
    draftView,
    diff: { ...diff, plan },
    request,
    pluginId,
    targetNextRevision,
  });
  await persistMutation({ mayBootstrap, lockContext, persistedState });
  return logEntry;
}

async function applyProviderMutation({ provider, tx, plan, request, snapshot, commandName }) {
  const applyResult = await provider.apply({ tx, plan, input: request.input, request, snapshot });
  return normalizeApplyResult(applyResult, commandName);
}

export async function executeProviderMutation({ projectDir, lockContext, request, provider, policyAction, pluginId, commandName }) {
  const loadedState = await readMutationStateUnderLock(lockContext, projectDir);
  const { snapshot, mayBootstrap } = initialSnapshot(loadedState, request, provider, commandName);
  const plan = await prepareMutationPlan({ provider, snapshot, request, pluginId, commandName });
  await runPolicy({ policyAction, snapshot, plan, request, commandName });
  const tx = createTransaction(snapshot);
  const outcome = await applyProviderMutation({ provider, tx, plan, request, snapshot, commandName });
  const draftView = tx.view({ includePlugins: true });
  validateDraftStructural(draftView, commandName);
  const diff = computeMutationDiff(snapshot, draftView);
  const isIdempotent = !mayBootstrap && diff.isIdempotent;
  const logEntry = isIdempotent ? null : await commitMutation({ snapshot, draftView, diff, request, pluginId, lockContext, mayBootstrap, plan });
  return {
    result: outcome.result,
    effects: outcome.effects,
    log_entry: logEntry,
    idempotent: isIdempotent,
    diff: {
      created: diff.created,
      updated: diff.updated,
      added_edges: diff.addedEdges,
      removed_edges: diff.removedEdges,
      removed_nodes: diff.removedNodes,
      target_revision: deriveTargetRevision(snapshot, plan, diff.created, diff.updated),
      initiatives: diff.initiativeDiff,
    },
  };
}
