// State-operation mutation phase for the kernel execution coordinator.

import fs from "node:fs/promises";
import path from "node:path";
import { readState, writeState, stateFile, createSnapshot } from "../../../storage/state.mjs";
import { recoverFencedStateUnderLock, replaceFencedStateUnderLock } from "../../../storage/ledger.mjs";
import { prepareLogEntry } from "../../../storage/log.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";
import { commandLabel, runPolicy, checkStateRevision } from "./shared.mjs";

async function inspectStateFile(statePath) {
  try {
    return { raw: await fs.readFile(statePath), exists: true };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { raw: null, exists: false };
    }
    throw error;
  }
}

async function hasFencedLedger(statePath) {
  try {
    await fs.access(path.join(path.dirname(statePath), "revision-ledger.json"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function loadCurrentState(projectDir, exists) {
  if (!exists) {
    return { currentState: null, stateError: null };
  }
  try {
    return { currentState: await readState(projectDir), stateError: null };
  } catch (error) {
    const recoverable = ["CLIMIER_CORRUPT_STATE", "STATE_V1_UNSUPPORTED", "CLIMIER_INCOMPATIBLE_VERSION"].includes(error.code);
    if (!recoverable) {
      throw error;
    }
    return { currentState: null, stateError: error };
  }
}

function snapshotNodes(state) {
  return state && state.nodes ? { ...state.nodes } : {};
}

function snapshotEdges(state) {
  return state && Array.isArray(state.edges) ? state.edges.slice() : [];
}

function snapshotInitiatives(state) {
  return state && state.initiatives ? { ...state.initiatives } : {};
}

function snapshotPlugins(state) {
  if (state && Object.prototype.hasOwnProperty.call(state, "plugins")) {
    return { plugins: state.plugins };
  }
  return {};
}

function snapshotRevision(state) {
  return state && Number.isInteger(state.revision) ? state.revision : 0;
}

function stateSnapshot({ currentState, raw, exists, stateError, fencedLedger }) {
  const snapshot = {
    state: currentState,
    raw,
    exists,
    stateError,
    nodes: snapshotNodes(currentState),
    edges: snapshotEdges(currentState),
    initiatives: snapshotInitiatives(currentState),
    ...snapshotPlugins(currentState),
    revision: snapshotRevision(currentState),
  };
  if (stateError?.code === "CLIMIER_CORRUPT_STATE" && exists && fencedLedger) {
    snapshot.fencedCorrupt = true;
  }
  return Object.freeze(snapshot);
}

async function loadMutationSnapshot(projectDir, statePath) {
  const file = await inspectStateFile(statePath);
  const fencedLedger = await hasFencedLedger(statePath);
  const loaded = await loadCurrentState(projectDir, file.exists);
  const snapshot = stateSnapshot({ ...file, ...loaded, fencedLedger });
  return { snapshot, currentState: loaded.currentState };
}

async function prepareStatePlan({ stateOperation, projectDir, snapshot, request, commandName }) {
  const prepared = await stateOperation.prepare({ projectDir, snapshot, input: request.input, request });
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || !prepared.target || typeof prepared.target.id !== "string") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation prepare must return a plan with target`, { field: "plan" });
  }
  return Object.freeze({ ...prepared, target: Object.freeze({ ...prepared.target }) });
}

async function applyStateOperation({ stateOperation, snapshot, plan, request, commandName }) {
  const applied = await stateOperation.apply({ snapshot, plan, input: request.input, request });
  if (!applied || typeof applied !== "object" || !applied.state || typeof applied.state !== "object" || Array.isArray(applied.state)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation apply must return a state object`, { field: "state" });
  }
  return applied;
}

async function savePlanSnapshot({ projectDir, plan, exists, statePath, commandName }) {
  if (!plan.snapshotReason) {
    return null;
  }
  if (!exists) {
    throwV2("INVALID_STATUS", `${commandName}: cannot snapshot a missing current state`, { state_file: statePath });
  }
  return createSnapshot(projectDir, plan.snapshotReason);
}

async function recoverCorruptFencedState({ plan, snapshot, lockContext, projectDir, applied, snapshotMeta }) {
  if (!plan.corruptRecovery || !snapshot.fencedCorrupt) {
    return null;
  }
  const recovered = await recoverFencedStateUnderLock(lockContext, undefined, { projectDir });
  return {
    result: { ...applied.result, snapshot: snapshotMeta },
    effects: applied.effects === undefined ? null : applied.effects,
    log_entry: null,
    idempotent: false,
    diff: { created: [], updated: [], added_edges: [], removed_edges: [], removed_nodes: [], target_revision: recovered.revision, initiatives: { created: [], updated: [] } },
  };
}

async function persistState({ lockContext, projectDir, fencedCurrentState, nextState }) {
  if (fencedCurrentState) {
    await replaceFencedStateUnderLock(lockContext, nextState, { projectDir });
  } else {
    await writeState(projectDir, nextState);
  }
}

function resultWithSnapshot(result, snapshotMeta) {
  if (!snapshotMeta || !result || typeof result !== "object" || Array.isArray(result) || result.snapshot !== undefined) {
    return result;
  }
  return { ...result, snapshot: snapshotMeta };
}

function stateMutationResult({ applied, logEntry, result }) {
  return {
    result,
    effects: applied.effects === undefined ? null : applied.effects,
    log_entry: logEntry,
    idempotent: false,
    diff: { created: [], updated: [], added_edges: [], removed_edges: [], removed_nodes: [], target_revision: null, initiatives: { created: [], updated: [] } },
  };
}

async function prepareApplyStateMutation({ stateOperation, projectDir, snapshot, request, commandName, policyAction }) {
  const plan = await prepareStatePlan({ stateOperation, projectDir, snapshot, request, commandName });
  checkStateRevision(request.if_state_revision, snapshot, commandName);
  const ledgerCorruptRecovery = plan.corruptRecovery && snapshot.fencedCorrupt;
  if (!ledgerCorruptRecovery) {
    await runPolicy({ policyAction, snapshot, plan, request, commandName });
  }
  const applied = await applyStateOperation({ stateOperation, snapshot, plan, request, commandName });
  return { plan, applied };
}

function createNextState({ applied, currentState, snapshot, plan, request, pluginId }) {
  const nextState = {
    ...applied.state,
    revision: currentState ? snapshot.revision + 1 : applied.state.revision,
  };
  let logEntry = null;
  if (plan.log) {
    logEntry = prepareLogEntry({ action: plan.logAction || request.action, agent: request.actor, ...plan.log }, { pluginId });
    nextState.log = [...(Array.isArray(nextState.log) ? nextState.log : []), logEntry];
  }
  return { nextState, logEntry };
}

async function finishStateMutation({ plan, snapshot, lockContext, projectDir, applied, snapshotMeta, currentState, request, pluginId }) {
  const recoveryResult = await recoverCorruptFencedState({ plan, snapshot, lockContext, projectDir, applied, snapshotMeta });
  if (recoveryResult) {
    return recoveryResult;
  }
  const { nextState, logEntry } = createNextState({ applied, currentState, snapshot, plan, request, pluginId });
  await persistState({ lockContext, projectDir, fencedCurrentState: Boolean(currentState && currentState.version === 5), nextState });
  const result = resultWithSnapshot(applied.result === undefined ? null : applied.result, snapshotMeta);
  return stateMutationResult({ applied, logEntry, result });
}

export async function executeStateMutation({ projectDir, lockContext, request, stateOperation, policyAction, pluginId }) {
  const commandName = commandLabel(request);
  const statePath = stateFile(projectDir);
  const { snapshot, currentState } = await loadMutationSnapshot(projectDir, statePath);
  const { plan, applied } = await prepareApplyStateMutation({ stateOperation, projectDir, snapshot, request, commandName, policyAction });
  const snapshotMeta = await savePlanSnapshot({ projectDir, plan, exists: snapshot.exists, statePath, commandName });
  return finishStateMutation({ plan, snapshot, lockContext, projectDir, applied, snapshotMeta, currentState, request, pluginId });
}
