// show: return the raw task or decision object by id.
import { readState } from "../state.mjs";

export default async function show({ statePath, positional }) {
  const [id] = positional;
  if (!id) throw new Error("show: id required (e.g. show T1 or show D1)");
  const projectDir = statePath.replace(/\.agents\/tasks\/tasks\.json$/, "");
  const s = await readState(projectDir);
  if (!s) throw new Error("show: state file missing");
  if (s.tasks[id]) return { type: "task", node: s.tasks[id] };
  if (s.decisions[id]) return { type: "decision", node: { status: "open", ...s.decisions[id] } };
  if (s.gotchas[id]) return { type: "gotcha", node: { status: "active", ...s.gotchas[id] } };
  throw new Error(`show: ${id} not found (no task, decision, or gotcha with that id)`);
}
