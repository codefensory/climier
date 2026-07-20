// F11 — v2 release: free a task's claim without resolving it.
//
// Behaviour:
//   - Owner: `claim = null`, `status = "open"`, revision++, log entry.
//   - Orchestrator or recovery: same, on any agent's claim.
//   - Anyone else: NOT_OWNER.
//   - Node without a claim (never claimed or already released): idempotent
//     `{ released: false, node }`, no state mutation, no log entry.
//   - Non-task nodes (gate / knowledge) cannot be released — they have no
//     claim lifecycle. Surfaces as INVALID_STATUS.
//
// v1 has its own release.mjs (this file deliberately does not touch it).
// bin/climier.mjs routes to this module when state.version === 2.
import { isV2State, readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = ["as"];

export default async function releaseV2({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "release: node id required", { field: "id" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "release");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("release: state file missing");
    if (!isV2State(s)) {
      throw new Error("release: v1 state is not supported by v2 release (use `release` on a v1 state)");
    }
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `release: node ${id} not found`, { id });
    if (node.kind !== "resolvable" || node.subkind !== "task") {
      throwV2(
        "INVALID_STATUS",
        `release: node ${id} is not a task (subkind=${node.subkind || node.kind})`,
        { id, subkind: node.subkind, kind: node.kind },
      );
    }
    // Idempotent: no claim → nothing to release.
    if (!node.claim || !node.claim.by) {
      return { released: false, node };
    }
    const isOrchestrator = as === "orchestrator" || as === "recovery";
    if (node.claim.by !== as && !isOrchestrator) {
      throwV2(
        "NOT_OWNER",
        `release: node ${id} is not yours (claimed by ${node.claim.by})`,
        { id, owner: node.claim.by },
      );
    }
    const updated = await updateState(projectDir, (st) => {
      const target = st.nodes[id];
      target.claim = null;
      target.status = "open";
      target.revision = (target.revision || 0) + 1;
      return st;
    });
    await append(projectDir, { agent: as, action: "release", node: id });
    return { released: true, node: updated.nodes[id] };
  });
}