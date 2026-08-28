// F11 — cancel: terminate a node without resolving it.
//
// Behaviour (ADR-009 §"Resto de operaciones"):
//   - Allowed when node.status is "open" or "in_progress".
//   - Any actor with `--as` can cancel. The core no longer requires
//     the actor to be the claim owner.
//   - status -> "canceled", claim cleared, revision++. Log with reason.
//   - Anything else (done, resolved, canceled, superseded, deprecated,
//     backlog): INVALID_STATUS with allowed=["open","in_progress"].
//   - Non-resolvable nodes: INVALID_STATUS.
//
// Policy seam (ADR-008 §"Tabla de resolve" / §3.4):
//   - Action: `task.cancel` (used for both tasks and gates because
//     cancellation applies to any open/in_progress resolvable).
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

const ALLOWED_STATUSES = ["open", "in_progress"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) return flags.reason.trim();
  return positional.slice(1).join(" ").trim();
}

export default async function cancelV2({ statePath, flags, positional, pluginId }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "cancel: node id required", { field: "id" });
  const reason = readReason(flags, positional);
  if (!reason) throwV2("MISSING_FIELD", "cancel: --reason required", { field: "reason" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "cancel");

  const policy = await loadApplicablePolicy({ projectDir });

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("cancel: state file missing");
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `cancel: node ${id} not found`, { id });
    if (node.kind !== "resolvable") {
      throwV2(
        "INVALID_STATUS",
        `cancel: node ${id} is not resolvable (kind=${node.kind})`,
        { id, kind: node.kind },
      );
    }
    const status = node.status || "open";
    if (!ALLOWED_STATUSES.includes(status)) {
      throwV2(
        "INVALID_STATUS",
        `cancel: node ${id} cannot be canceled from status ${status}`,
        { id, current: status, allowed: ALLOWED_STATUSES },
      );
    }

    // Build snapshot + target for the seam. ADR-009 removes the owner
    // invariant: the seam decides whether to deny; the default core
    // (abstain) lets any actor cancel an open/in_progress node.
    const target = {
      id: node.id,
      kind: node.kind,
      subkind: node.subkind,
      status: node.status,
      claim: node.claim ? { ...node.claim } : null,
    };
    const snapshot = {
      state: s,
      nodes: { ...s.nodes },
      edges: s.edges.slice(),
      initiatives: { ...s.initiatives },
    };

    const decision = await authorizeAction({
      policy,
      action: "task.cancel",
      actor: as,
      target,
      snapshot,
      projectDir,
      projectConfig: policy ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(
        policy && policy.pluginId ? policy.pluginId : "(unknown)",
        "task.cancel",
        as,
        decision.reason || "denied by policy",
      );
    }
    // allow / abstain → proceed.

    const updated = await updateState(projectDir, (st) => {
      const target = st.nodes[id];
      target.status = "canceled";
      target.claim = null;
      target.revision = (target.revision || 0) + 1;
      return st;
    });
    await appendWithContext(
      projectDir,
      { agent: as, action: "cancel", node: id, note: reason },
      { pluginId },
    );
    return { node: updated.nodes[id] };
  });
}
