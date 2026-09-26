// State-operation mutation phase for the kernel execution coordinator.

import fs from "node:fs/promises";
import path from "node:path";
import { readState, writeState, stateFile, createSnapshot } from "../../../storage/state.mjs";
import { recoverFencedStateUnderLock, replaceFencedStateUnderLock } from "../../../storage/ledger.mjs";
import { prepareLogEntry } from "../../../storage/log.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";
import { commandLabel, runPolicy, checkStateRevision } from "./shared.mjs";

export async function executeStateMutation({ projectDir, lockContext, request, stateOperation, policyAction, pluginId }) {
  const commandName = commandLabel(request);
  const statePath = stateFile(projectDir);
  let currentRaw = null;
  let currentState = null;
  let exists = false;
  let fencedCurrentState = null;
  try {
    currentRaw = await fs.readFile(statePath);
    exists = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let stateError = null;
  let hasFencedLedger = false;
  try {
    await fs.access(path.join(path.dirname(statePath), "revision-ledger.json"));
    hasFencedLedger = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (exists) {
    try {
      currentState = await readState(projectDir);
      if (currentState && currentState.version === 5) fencedCurrentState = currentState;
    } catch (err) {
      if (!["CLIMIER_CORRUPT_STATE", "STATE_V1_UNSUPPORTED", "CLIMIER_INCOMPATIBLE_VERSION"].includes(err.code)) throw err;
      stateError = err;
    }
  }
  let snapshot = Object.freeze({
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
  if (snapshot.stateError?.code === "CLIMIER_CORRUPT_STATE" && exists && hasFencedLedger) {
    snapshot = Object.freeze({ ...snapshot, fencedCorrupt: true });
  }
  const prepared = await stateOperation.prepare({ projectDir, snapshot, input: request.input, request });
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || !prepared.target || typeof prepared.target.id !== "string") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation prepare must return a plan with target`, { field: "plan" });
  }
  const plan = Object.freeze({ ...prepared, target: Object.freeze({ ...prepared.target }) });
  checkStateRevision(request.if_state_revision, snapshot, commandName);
  const ledgerCorruptRecovery = plan.corruptRecovery && snapshot.fencedCorrupt;
  if (!ledgerCorruptRecovery) await runPolicy(policyAction, snapshot, plan, request, commandName);
  const applied = await stateOperation.apply({ snapshot, plan, input: request.input, request });
  if (!applied || typeof applied !== "object" || !applied.state || typeof applied.state !== "object" || Array.isArray(applied.state)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation apply must return a state object`, { field: "state" });
  }
  let snapshotMeta = null;
  if (plan.snapshotReason) {
    if (!exists) throwV2("INVALID_STATUS", `${commandName}: cannot snapshot a missing current state`, { state_file: statePath });
    snapshotMeta = await createSnapshot(projectDir, plan.snapshotReason);
  }
  if (plan.corruptRecovery && snapshot.fencedCorrupt) {
    const recovered = await recoverFencedStateUnderLock(lockContext, undefined, { projectDir });
    return {
      result: { ...applied.result, snapshot: snapshotMeta },
      effects: applied.effects === undefined ? null : applied.effects,
      log_entry: null,
      idempotent: false,
      diff: { created: [], updated: [], added_edges: [], removed_edges: [], removed_nodes: [], target_revision: recovered.revision, initiatives: { created: [], updated: [] } },
    };
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
  if (fencedCurrentState) {
    await replaceFencedStateUnderLock(lockContext, nextState, { projectDir });
  } else {
    await writeState(projectDir, nextState);
  }
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
