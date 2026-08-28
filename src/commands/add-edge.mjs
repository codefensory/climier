import { readState, updateState, assertStateVersion } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { appendWithContext } from "../log.mjs";
import { EDGE_TYPES, existingEdge, validateEdge } from "../v2.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";

export const knownFlags = ["type", "as"];

export default async function addEdge({ statePath, positional, flags, pluginId }) {
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

  // T-plugin-policy-seam-dag — ADR-008 §"Seam por handler":
  // load the applicable policy BEFORE the lock. The decision itself
  // runs INSIDE the lock against the snapshot read under the lock.
  const policy = await loadApplicablePolicy({ projectDir });

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

    // F8: resolveAgent runs after edge validation but BEFORE the seam,
    // so a missing agent rejects without entering authorizeAction or
    // updateState.
    const agent = resolveAgent(flags, "add-edge");

    // T-plugin-policy-seam-dag — ADR-008 §"Acciones canónicas":
    // `edge.add` is the canonical action for any new edge. The target
    // carries the edge payload (no node id); the snapshot exposes the
    // full DAG so the policy can branch on from/to/type.
    const decision = await authorizeAction({
      policy,
      action: "edge.add",
      actor: agent,
      target: { from, to, type },
      snapshot: s,
      projectDir,
      projectConfig: policy && policy.projectConfig ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(policy.pluginId, "edge.add", agent, decision.reason);
    }

    await updateState(projectDir, (st) => {
      st.edges.push(edge);
      return st;
    });
    await appendWithContext(
      projectDir,
      { agent, action: "add-edge", node: to, note: `${from} ${type} ${to}` },
      { pluginId },
    );
    return { edge };
  });
}
