// F11 — reopen: roll a terminal resolvable back to open.
//
// Behaviour (ADR-009 §"Resto de operaciones"):
//   - task (subkind=task, status=done): status -> "open", claim cleared,
//     done_by/at/note removed, revision++. Log with reason.
//   - gate (subkind=gate, status=resolved): same; clearing the gate means
//     re-deciding it, so the previous resolution is removed too.
//   - Any actor with `--as` may reopen. The core no longer compares
//     against `done_by` (which is also removed as part of the reopen).
//   - Wrong status: INVALID_STATUS.
//   - Non-resolvable nodes: INVALID_STATUS.
//
// Policy seam (ADR-008 §"Tabla de resolve" / §3.4):
//   - Action: `task.reopen` (and gate reopen shares the same action
//     identifier; the seam distinguishes by `target.subkind`).
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

export const knownFlags = ["as", "reason"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) return flags.reason.trim();
  // Fallback: accept a trailing positional reason so a careless agent
  // doesn't get a confusing MISSING_FIELD.
  const trailing = positional.slice(1).join(" ").trim();
  return trailing;
}

export default async function reopenV2({ statePath, flags, positional, pluginId }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "reopen: node id required", { field: "id" });
  const reason = readReason(flags, positional);
  if (!reason) throwV2("MISSING_FIELD", "reopen: --reason required", { field: "reason" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "reopen");

  const policy = await loadApplicablePolicy({ projectDir });

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("reopen: state file missing");
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `reopen: node ${id} not found`, { id });
    if (node.kind !== "resolvable") {
      throwV2(
        "INVALID_STATUS",
        `reopen: node ${id} is not resolvable (kind=${node.kind})`,
        { id, kind: node.kind },
      );
    }
    const terminal = node.subkind === "task" ? "done" : "resolved";
    if (node.status !== terminal) {
      throwV2(
        "INVALID_STATUS",
        `reopen: node ${id} is not ${terminal} (status=${node.status || "open"})`,
        { id, current: node.status || "open", expected: terminal },
      );
    }

    // Build snapshot + target for the seam.
    const target = {
      id: node.id,
      kind: node.kind,
      subkind: node.subkind,
      status: node.status,
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
      action: "task.reopen",
      actor: as,
      target,
      snapshot,
      projectDir,
      projectConfig: policy ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(
        policy && policy.pluginId ? policy.pluginId : "(unknown)",
        "task.reopen",
        as,
        decision.reason || "denied by policy",
      );
    }
    // allow / abstain → proceed.

    const updated = await updateState(projectDir, (st) => {
      const target = st.nodes[id];
      target.status = "open";
      target.claim = null;
      delete target.done_by;
      delete target.done_at;
      delete target.note;
      delete target.resolution;
      target.revision = (target.revision || 0) + 1;
      return st;
    });
    await appendWithContext(
      projectDir,
      { agent: as, action: "reopen", node: id, note: reason },
      { pluginId },
    );
    return { node: updated.nodes[id] };
  });
}
