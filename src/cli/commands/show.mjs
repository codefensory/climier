// show: return the raw node by id.
import { readState, isFencedState, isV2State } from "../../storage/state.mjs";
import { throwV2 } from "../../contracts/errors.mjs";

export const knownFlags = [];

function findLegacyNode(snapshot, id) {
  if (snapshot.tasks[id]) {return { type: "task", node: snapshot.tasks[id] };}
  if (snapshot.decisions[id]) {return { type: "decision", node: { status: "open", ...snapshot.decisions[id] } };}
  if (snapshot.gotchas[id]) {return { type: "gotcha", node: { status: "active", ...snapshot.gotchas[id] } };}
  throw new Error(`show: ${id} not found (no task, decision, or gotcha with that id)`);
}

function findCurrentNode(snapshot, id) {
  const node = snapshot.nodes[id];
  if (!node) {throwV2("NODE_NOT_FOUND", `show: ${id} not found`, { id });}
  return { type: node.subkind || node.kind, node };
}

async function readNode(statePath, id) {
  const snapshot = await readState(statePath);
  if (!snapshot) {throw new Error("show: state file missing");}
  return isV2State(snapshot) || isFencedState(snapshot)
    ? findCurrentNode(snapshot, id)
    : findLegacyNode(snapshot, id);
}

export default async function show({ statePath, positional, backendClient }) {
  const [id] = positional;
  if (!id) {throw new Error("show: id required (e.g. show T1 or show D1)");}
  if (backendClient?.type === "remote") {return backendClient.readNode({ id });}
  return readNode(statePath, id);
}
