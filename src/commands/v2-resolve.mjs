// F11 — v2 resolve: close out a resolvable node.
//
//   - task (subkind=task): requires `--note`, agent must own the claim.
//     status -> "done", done_by/at stored, note stored, claim cleared,
//     revision++. Log entry with action="resolve" and the note.
//   - gate (subkind=gate): requires `--choice` and `--rationale`. Any
//     agent with `--as` may resolve a gate (gates are not claimable).
//     status -> "resolved", node.resolution = { choice, rationale },
//     revision++. Log entry with choice+rationale.
//
// Returns `{ node, newly_ready }` where newly_ready is the set of task
// ids that transitioned from blocked to ready because of this resolution
// (computed as the symmetric diff of deriveV2().ready before/after).
// Includes the case of a gate resolving: a task blocked by exactly this
// gate and no other blockers becomes ready.
//
// bin/climier.mjs routes to this module when state.version === 2.
import { isV2State, readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { deriveV2 } from "../v2.mjs";

export const knownFlags = ["as", "note", "choice", "rationale"];

function nonEmpty(raw, field, command) {
  if (typeof raw !== "string" || !raw.trim()) {
    throwV2("MISSING_FIELD", `${command}: --${field} required`, { field, command });
  }
  return raw;
}

export default async function resolveV2({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "resolve: node id required", { field: "id" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "resolve");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("resolve: state file missing");
    if (!isV2State(s)) {
      throw new Error("resolve: v1 state is not supported by v2 resolve");
    }
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `resolve: node ${id} not found`, { id });
    if (node.kind !== "resolvable") {
      throwV2(
        "INVALID_STATUS",
        `resolve: node ${id} is not resolvable (kind=${node.kind})`,
        { id, kind: node.kind },
      );
    }

    // Snapshot readiness BEFORE the mutation so we can compute the diff.
    // ponytail: a Set diff is O(n) and avoids re-deriving via the inverse
    // edge walk; the alternative (compute blockers of `id` and re-evaluate
    // each) is more code for the same answer.
    const beforeReady = new Set(deriveV2(s).ready);

    if (node.subkind === "task") {
      const note = nonEmpty(flags.note, "note", "resolve");
      const ownerBy = node.claim && node.claim.by;
      if (!ownerBy) {
        throwV2(
          "NOT_OWNER",
          `resolve: task ${id} has no active claim (take it before resolving)`,
          { id },
        );
      }
      if (ownerBy !== as) {
        throwV2(
          "NOT_OWNER",
          `resolve: task ${id} is not yours (claimed by ${ownerBy})`,
          { id, owner: ownerBy },
        );
      }
      const doneAt = new Date().toISOString();
      const updated = await updateState(projectDir, (st) => {
        const target = st.nodes[id];
        target.status = "done";
        target.done_by = as;
        target.done_at = doneAt;
        target.note = note;
        target.claim = null;
        target.revision = (target.revision || 0) + 1;
        return st;
      });
      const afterReady = new Set(deriveV2(updated).ready);
      const newlyReady = [...afterReady].filter((rid) => !beforeReady.has(rid)).sort();
      await append(projectDir, { agent: as, action: "resolve", node: id, note });
      return { node: updated.nodes[id], newly_ready: newlyReady };
    }

    if (node.subkind === "gate") {
      const choice = nonEmpty(flags.choice, "choice", "resolve");
      const rationale = nonEmpty(flags.rationale, "rationale", "resolve");
      const updated = await updateState(projectDir, (st) => {
        const target = st.nodes[id];
        target.status = "resolved";
        target.resolution = { choice, rationale };
        target.revision = (target.revision || 0) + 1;
        return st;
      });
      const afterReady = new Set(deriveV2(updated).ready);
      const newlyReady = [...afterReady].filter((rid) => !beforeReady.has(rid)).sort();
      await append(projectDir, { agent: as, action: "resolve", node: id, choice, rationale });
      return { node: updated.nodes[id], newly_ready: newlyReady };
    }

    throwV2(
      "INVALID_STATUS",
      `resolve: node ${id} is not a task or gate (subkind=${node.subkind})`,
      { id, subkind: node.subkind },
    );
  });
}