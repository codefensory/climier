// F12 — `deprecate-knowledge`: soft-delete a knowledge node.
//
// v2 only. Validates kind === "knowledge", sets status="deprecated" plus the
// deprecation_reason / deprecated_at / deprecated_by / revision fields, and
// logs a deprecate-knowledge entry. v1 already has its own workflow on tasks
// (`archive`); this command is the v2 knowledge counterpart.
//
// ponytail: minimal validations inline; reuse take.mjs's pattern of resolveAgent.
import { readState, updateState, isV2State } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = ["reason", "as"];

export default async function deprecateKnowledge({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "deprecate-knowledge: node id required", { field: "id" });
  const reason = flags.reason;
  if (reason === true || !reason || !String(reason).trim()) {
    throwV2("MISSING_FIELD", "deprecate-knowledge: --reason is required", { field: "reason" });
  }
  const projectDir = statePath;

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("deprecate-knowledge: state file missing");
    if (!isV2State(s)) {
      throw new Error("deprecate-knowledge: requires a v2 state (run `climier init --v2`)");
    }
    const node = s.nodes[id];
    if (!node) {
      throwV2("NODE_NOT_FOUND", `deprecate-knowledge: node ${id} not found`, { id });
    }
    if (node.kind !== "knowledge") {
      throwV2(
        "INVALID_EDGE_KIND",
        `deprecate-knowledge: ${id} is not a knowledge node (got kind=${node.kind})`,
        { id, kind: node.kind },
      );
    }

    const as = resolveAgent(flags, "deprecate-knowledge");
    const updated = await updateState(projectDir, (st) => {
      const target = st.nodes[id];
      target.status = "deprecated";
      target.deprecation_reason = String(reason);
      target.deprecated_at = new Date().toISOString();
      target.deprecated_by = as;
      target.revision = (target.revision || 0) + 1;
      return st;
    });
    await append(projectDir, {
      agent: as,
      action: "deprecate-knowledge",
      node: id,
      reason: String(reason),
    });
    return { node: updated.nodes[id] };
  });
}
