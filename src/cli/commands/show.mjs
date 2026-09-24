// show: return the raw node by id.
import { readState, isV2State } from "../../storage/state.mjs";
import { throwV2 } from "../../contracts/errors.mjs";

export const knownFlags = ["fields", "slim"];

const SLIM_FIELDS = Object.freeze(["id", "kind", "subkind", "title", "status", "initiative", "revision"]);

function parseFields(flags) {
  if (flags.fields === undefined || flags.fields === null) return null;
  if (flags.fields === true) throw new Error("show: --fields requires a value (e.g. --fields id,title,status)");
  const keys = String(flags.fields).split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("show: --fields requires a value (e.g. --fields id,title,status)");
  return keys;
}

function projectNode(node, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(node, key)) out[key] = node[key];
  }
  return out;
}
export default async function show({ statePath, positional, flags = {} }) {
  const [id] = positional;
  if (!id) throw new Error("show: id required (e.g. show T1 or show D1)");
  const fields = parseFields(flags);
  const slim = flags.slim === true || flags.slim === "true";
  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) throw new Error("show: state file missing");
  if (isV2State(s)) {
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `show: ${id} not found`, { id });
    const keys = fields || (slim ? SLIM_FIELDS : null);
    return { type: node.subkind || node.kind, node: keys ? projectNode(node, keys) : node };
  }
  if (s.tasks[id]) return { type: "task", node: s.tasks[id] };
  if (s.decisions[id]) return { type: "decision", node: { status: "open", ...s.decisions[id] } };
  if (s.gotchas[id]) return { type: "gotcha", node: { status: "active", ...s.gotchas[id] } };
  throw new Error(`show: ${id} not found (no task, decision, or gotcha with that id)`);
}
