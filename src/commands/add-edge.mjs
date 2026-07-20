import { readState, updateState, assertStateVersion } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { EDGE_TYPES, existingEdge, validateEdge } from "../v2.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = ["type", "as"];

export default async function addEdge({ statePath, positional, flags }) {
  const [from, to] = positional;
  if (!from || !to) throwV2("MISSING_FIELD", "add-edge: from and to ids required", { field: "from,to" });
  if (!flags.type) throwV2("MISSING_FIELD", "add-edge: --type required", { field: "type" });
  const type = String(flags.type).toUpperCase();
  if (!EDGE_TYPES.includes(type)) {
    throwV2(
      "INVALID_EDGE_TYPE",
      `add-edge: --type must be one of ${EDGE_TYPES.join(", ")} (got '${flags.type}')`,
      { type, allowed: EDGE_TYPES },
    );
  }
  const projectDir = statePath;

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("add-edge: state file missing");
    assertStateVersion(s, 2, "add-edge");
    const edge = { from, to, type };
    validateEdge(s, edge, "add-edge");
    if (existingEdge(s, from, to, type)) {
      throwV2(
        "DUPLICATE_EDGE",
        `add-edge: ${type} edge ${from} -> ${to} already exists`,
        { from, to, type },
      );
    }

    // F8: resolveAgent runs before updateState so a missing agent rejects
    // without leaving an orphan edge / log entry. Edge validation already
    // ran above; this is the last gate before mutating.
    const agent = resolveAgent(flags, "add-edge");
    await updateState(projectDir, (st) => {
      st.edges.push(edge);
      return st;
    });
    await append(projectDir, { agent, action: "add-edge", note: `${from} ${type} ${to}` });
    return { edge };
  });
}
