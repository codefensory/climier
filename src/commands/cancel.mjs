// F11 — cancel: terminate a node without resolving it.
//
// Behaviour (T-plugin-policy-seam-lifecycle / ADR-008):
//   - Allowed when node.status is "open" or "in_progress".
//   - Authority: claim owner. For an unclaimed node (status=open) only
//     a policy plugin may authorize cancellation by another actor
//     (ADR-008 §"Tabla de resolve" + §3.4).
//   - status -> "canceled", claim cleared, revision++. Log with reason.
//   - Anything else (done, resolved, canceled, superseded, deprecated,
//     backlog): INVALID_STATUS with allowed=["open","in_progress"].
//   - Non-resolvable nodes: INVALID_STATUS.
//
// Policy seam (ADR-008 §"Tabla de resolve" / §3.4):
//   - Action: `task.cancel` (used for both tasks and gates because
//     cancellation applies to any open/in_progress resolvable).
//   - allow   → proceed (skip the no-claim check).
//   - deny    → POLICY_DENIED, no state mutation, no log entry.
//   - abstain → default core (NOT_OWNER for non-owners; for unclaimed
//               nodes the owner check fails because there is no claim).
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

    const ownerBy = node.claim && node.claim.by;
    const isOwner = ownerBy === as;

    // Build snapshot + target for the seam. ADR-008 §"Invariantes
    // core" + §3.4: gates do not have a claim lifecycle, but cancel
    // is still routed through the seam because the action can mutate
    // status. The owner check uses claim for tasks; for gates the
    // claim is null and any non-policy decision falls back to NOT_OWNER
    // so a no-actor can never cancel a gate by default (matches the
    // historical behaviour — cancellation is not bootstrap).
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

    // Default core: only the claim owner can cancel. For unclaimed
    // nodes (open) this fails because ownerBy is null.
    if (decision.decision === "abstain" && !isOwner) {
      throwV2(
        "NOT_OWNER",
        `cancel: node ${id} is not yours (no claim by ${as})`,
        { id, owner: ownerBy || null },
      );
    }

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
