// show: return the raw node by id.
import { readState, isV2State } from "../state.mjs";
import { throwV2 } from "../errors.mjs";

export const knownFlags = [];

export default async function show({ statePath, positional }) {
  const [id] = positional;
  if (!id) throw new Error("show: id required (e.g. show T1 or show D1)");
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) throw new Error("show: state file missing");
  if (isV2State(s)) {
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `show: ${id} not found`, { id });
    return { type: node.subkind || node.kind, node };
  }
  if (s.tasks[id]) return { type: "task", node: s.tasks[id] };
  if (s.decisions[id]) return { type: "decision", node: { status: "open", ...s.decisions[id] } };
  if (s.gotchas[id]) return { type: "gotcha", node: { status: "active", ...s.gotchas[id] } };
  throw new Error(`show: ${id} not found (no task, decision, or gotcha with that id)`);
}
