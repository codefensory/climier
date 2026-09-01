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
import { checkPrecondition, selectPrecondition } from "./preconditions.mjs";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  deepEqualNodes,
} from "./diff.mjs";
import { deriveTargetRevision } from "./revisions.mjs";
import { normalizeLogFields, validateDraftStructural } from "./validation.mjs";
import { buildLogEntry } from "./log-entry.mjs";

/**
 * Validate arguments accepted by kernel.mutate before execution begins.
 * Returns the operation label used in contract errors.
 */
export function validateMutationArguments({ request, provider, stateOperation } = {}) {
  validateRequest(request);
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
  });
  const prepared = await stateOperation.prepare({ projectDir, snapshot, input: request.input, request });
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || !prepared.target || typeof prepared.target.id !== "string") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation prepare must return a plan with target`, { field: "plan" });
  }
  const plan = Object.freeze({ ...prepared, target: Object.freeze({ ...prepared.target }) });
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
  const nextState = { ...applied.state };
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
export async function executeMutation({ projectDir, request, provider, policyAction, pluginId, stateOperation }) {
  const commandName = validateMutationArguments({ request, provider, stateOperation });
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
export { commandLabel, operationLabel };
