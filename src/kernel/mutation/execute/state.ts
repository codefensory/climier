import { readState, stateFile, sqliteStateFile, createSnapshot } from "../../../storage/state.ts";
import { writeSqliteState } from "../../../storage/sqlite/store.ts";
import { prepareLogEntry } from "../../../storage/log.ts";
import { throwV2 } from "../../../contracts/errors.ts";
import { commandLabel, runPolicy, checkStateRevision } from "./shared.ts";

type MutationSnapshot = Record<string, unknown> & {
  state: Record<string, unknown> | null;
  exists: boolean;
  stateError: null;
  nodes: Record<string, unknown>;
  edges: unknown[];
  initiatives: Record<string, unknown>;
  revision: number;
};

function snapshotOf(state: Record<string, unknown> | null): MutationSnapshot {
  return Object.freeze({
    state,
    exists: state !== null,
    stateError: null,
    nodes: state?.nodes && typeof state.nodes === "object" ? { ...state.nodes } : {},
    edges: Array.isArray(state?.edges) ? state.edges.slice() : [],
    initiatives: state?.initiatives && typeof state.initiatives === "object" ? { ...state.initiatives } : {},
    ...(state && Object.hasOwn(state, "plugins") ? { plugins: state.plugins } : {}),
    revision: state && Number.isInteger(state.revision) ? state.revision as number : 0,
  }) as MutationSnapshot;
}

async function loadMutationSnapshot(projectDir: string) {
  const currentState = await readState(projectDir) as Record<string, unknown> | null;
  return { snapshot: snapshotOf(currentState), currentState };
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
  if (!plan.snapshotReason) { return null; }
  if (!exists) {
    throwV2("INVALID_STATUS", `${commandName}: cannot snapshot a missing current state`, { state_file: statePath });
  }
  return createSnapshot(projectDir, plan.snapshotReason);
}

function resultWithSnapshot(result, snapshotMeta) {
  if (!snapshotMeta || !result || typeof result !== "object" || Array.isArray(result) || result.snapshot !== undefined) { return result; }
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
  await runPolicy({ policyAction, snapshot, plan, request, commandName });
  const applied = await applyStateOperation({ stateOperation, snapshot, plan, request, commandName });
  return { plan, applied };
}

function nodeRevisions(nodes: Record<string, Record<string, unknown>>, highWaterRevision: number, preserve: boolean) {
  if (preserve) { return nodes; }
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => {
    const cleanNode = { ...node };
    delete cleanNode.revision;
    return [id, { ...cleanNode, revision: highWaterRevision }];
  }));
}

function createNextState({ applied, currentState, snapshot, plan, request, pluginId }) {
  const nextState = { ...applied.state };
  let logEntry = null;
  if (plan.log) {
    logEntry = prepareLogEntry({ action: plan.logAction || request.action, agent: request.actor, ...plan.log }, { pluginId });
    nextState.log = [...(Array.isArray(nextState.log) ? nextState.log : []), logEntry];
  }
  const nodes = nextState.nodes && typeof nextState.nodes === "object" ? nextState.nodes as Record<string, Record<string, unknown>> : {};
  const highWaterRevision = Math.max(
    Number.isInteger(currentState?.revision) ? currentState.revision as number : 0,
    Number.isInteger(nextState.revision) ? nextState.revision as number : 0,
    ...Object.values(nodes).map((node) => Number.isInteger(node?.revision) ? node.revision as number : 0),
  ) + 1;
  nextState.revision = highWaterRevision;
  nextState.nodes = nodeRevisions(nodes, highWaterRevision, plan.preserveNodeRevisions === true);
  if (!snapshot.plugins && !nextState.plugins) { delete nextState.plugins; }
  return { nextState, logEntry };
}

async function finishStateMutation({ plan, projectDir, applied, snapshotMeta, currentState, snapshot, request, pluginId }) {
  const { nextState, logEntry } = createNextState({ applied, currentState, snapshot, plan, request, pluginId });
  await writeSqliteState(sqliteStateFile(projectDir), nextState, currentState);
  const result = resultWithSnapshot(applied.result === undefined ? null : applied.result, snapshotMeta);
  return stateMutationResult({ applied, logEntry, result });
}

export async function executeStateMutation({ projectDir, request, stateOperation, policyAction, pluginId }) {
  const commandName = commandLabel(request);
  const statePath = stateFile(projectDir);
  const { snapshot, currentState } = await loadMutationSnapshot(projectDir);
  const { plan, applied } = await prepareApplyStateMutation({ stateOperation, projectDir, snapshot, request, commandName, policyAction });
  const snapshotMeta = await savePlanSnapshot({ projectDir, plan, exists: snapshot.exists, statePath, commandName });
  return finishStateMutation({ plan, projectDir, applied, snapshotMeta, currentState, snapshot, request, pluginId });
}
