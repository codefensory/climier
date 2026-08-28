// F11 — resolve: close out a resolvable node.
//
//   - task (subkind=task): requires `--note`. Any agent with `--as`
//     may resolve a task whose status is `open` or `in_progress`.
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
// ADR-009 §"Resto de operaciones": the core does NOT compare the actor
// against the claim or done_by. Any actor with `--as` may resolve a
// task or gate whose state is valid for the transition. A policy
// plugin may still deny the action; an allow or abstain falls through
// to the default core (which is: proceed).
//   - Action: `task.resolve` (used for both tasks and gates).
//   - allow   → proceed.
//   - deny    → POLICY_DENIED, no state mutation, no log entry.
//   - abstain → default core (proceed; any actor is authorized).
//   - throw / invalid response → POLICY_ERROR propagates verbatim.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { appendWithContext } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";
import { deriveV2 } from "../v2.mjs";

export const knownFlags = ["as", "note", "choice", "rationale"];

function nonEmpty(raw, field, command) {
  if (typeof raw !== "string" || !raw.trim()) {
    throwV2("MISSING_FIELD", `${command}: --${field} required`, { field, command });
  }
  return raw;
}

export default async function resolveV2({ statePath, flags, positional, pluginId }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "resolve: node id required", { field: "id" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "resolve");

  const policy = await loadApplicablePolicy({ projectDir });

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("resolve: state file missing");
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

      // Build snapshot + target for the seam.
      const target = {
        id: node.id,
        kind: node.kind,
        subkind: node.subkind,
        status: node.status,
        claim: node.claim ? { ...node.claim } : null,
        done_by: node.done_by || null,
      };
      const snapshot = {
        state: s,
        nodes: { ...s.nodes },
        edges: s.edges.slice(),
        initiatives: { ...s.initiatives },
      };
      const decision = await authorizeAction({
        policy,
        action: "task.resolve",
        actor: as,
        target,
        snapshot,
        projectDir,
        projectConfig: policy ? policy.projectConfig : {},
      });
      if (decision.decision === "deny") {
        throw new PolicyDenied(
          policy && policy.pluginId ? policy.pluginId : "(unknown)",
          "task.resolve",
          as,
          decision.reason || "denied by policy",
        );
      }
      // allow / abstain → proceed.

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
      await appendWithContext(
        projectDir,
        { agent: as, action: "resolve", node: id, note },
        { pluginId },
      );
      return { node: updated.nodes[id], newly_ready: newlyReady };
    }

    if (node.subkind === "gate") {
      const choice = nonEmpty(flags.choice, "choice", "resolve");
      const rationale = nonEmpty(flags.rationale, "rationale", "resolve");

      // ADR-009 §"Resto de operaciones": gates also accept any actor
      // with `--as`; the seam decides whether the action is denied.
      const target = {
        id: node.id,
        kind: node.kind,
        subkind: node.subkind,
        status: node.status,
      };
      const snapshot = {
        state: s,
        nodes: { ...s.nodes },
        edges: s.edges.slice(),
        initiatives: { ...s.initiatives },
      };
      const decision = await authorizeAction({
        policy,
        action: "task.resolve",
        actor: as,
        target,
        snapshot,
        projectDir,
        projectConfig: policy ? policy.projectConfig : {},
      });
      if (decision.decision === "deny") {
        throw new PolicyDenied(
          policy && policy.pluginId ? policy.pluginId : "(unknown)",
          "task.resolve",
          as,
          decision.reason || "denied by policy",
        );
      }
      // allow / abstain → proceed (default core).

      const updated = await updateState(projectDir, (st) => {
        const target = st.nodes[id];
        target.status = "resolved";
        target.resolution = { choice, rationale };
        target.revision = (target.revision || 0) + 1;
        return st;
      });
      const afterReady = new Set(deriveV2(updated).ready);
      const newlyReady = [...afterReady].filter((rid) => !beforeReady.has(rid)).sort();
      await appendWithContext(
        projectDir,
        { agent: as, action: "resolve", node: id, choice, rationale },
        { pluginId },
      );
      return { node: updated.nodes[id], newly_ready: newlyReady };
    }

    throwV2(
      "INVALID_STATUS",
      `resolve: node ${id} is not a task or gate (subkind=${node.subkind})`,
      { id, subkind: node.subkind },
    );
  });
}
