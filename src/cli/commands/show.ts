
import { sqliteStateExists, stateFile } from "../../storage/state.ts";
import { readSqliteNode } from "../../storage/sqlite/store.ts";
import { throwV2 } from "../../contracts/errors.ts";

export const knownFlags = [];

function showNode(node, id) {
  if (!node) {throwV2("NODE_NOT_FOUND", `show: ${id} not found`, { id });}
  return { type: node.subkind || node.kind, node };
}

async function readNode(statePath, id) {
  const node = await readSqliteNode(stateFile(statePath), id);
  if (!node) {
    if (!(await sqliteStateExists(statePath))) {throw new Error("show: state file missing");}
    throwV2("NODE_NOT_FOUND", `show: ${id} not found`, { id });
  }
  return showNode(node, id);
}

export default async function show({ statePath, positional, backendClient }) {
  const [id] = positional;
  if (!id) {throw new Error("show: id required (e.g. show T1 or show D1)");}
  if (backendClient?.type === "remote") {return backendClient.readNode({ id });}
  return readNode(statePath, id);
}
