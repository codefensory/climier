// F11 — release: free a task's claim without resolving it.
//
// Behaviour (T-plugin-policy-seam-lifecycle / ADR-008):
//   - Owner: `claim = null`, `status = "open"`, revision++, log entry.
//   - Non-owner: NOT_OWNER (unless a policy plugin explicitly allows
//     the operation; ADR-008 §"Invariantes core" + §"Tabla de take").
//   - Anyone else (no policy installed, or policy abstains): NOT_OWNER
//     — the default-core owner check still applies (ADR-008 §3.4).
//   - Node without a claim (never claimed or already released): idempotent
//     `{ released: false, node }`, no state mutation, no log entry,
//     no seam invocation (the idempotent short-circuits BEFORE the
//     seam per ADR-008 §3.4 / plan §3.4).
//   - Non-task nodes (gate / knowledge) cannot be released — they have no
//     claim lifecycle. Surfaces as INVALID_STATUS.
//
// Policy seam (ADR-008 §"Tabla de resolve" / §3.4):
//   - Action: `task.release`.
//   - allow   → proceed (the no-owner check is skipped because policy
//               already authorized the actor; a plugin can grant
//               takeover-style release to non-owners).
//   - deny    → POLICY_DENIED, no state mutation, no log entry.
//   - abstain → default core (NOT_OWNER for non-owners).
//   - throw / invalid response → POLICY_ERROR propagates verbatim.
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { appendWithContext } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";

export const knownFlags = ["as"];

export default async function releaseV2({ statePath, flags, positional, pluginId }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "release: node id required", { field: "id" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "release");

  // Resolve the applicable policy BEFORE the lock — ADR-007 §"Discovery
  // global" item 5 forbids caching across commands, and policy import
  // is not allowed inside the lock because plugins do not have access
  // to mutable state during `applies`.
  const policy = await loadApplicablePolicy({ projectDir });

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("release: state file missing");
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `release: node ${id} not found`, { id });
    if (node.kind !== "resolvable" || node.subkind !== "task") {
      throwV2(
        "INVALID_STATUS",
        `release: node ${id} is not a task (subkind=${node.subkind || node.kind})`,
        { id, subkind: node.subkind, kind: node.kind },
      );
    }
    // Idempotent: no claim → nothing to release. ADR-008 §3.4 says the
    // idempotent short-circuit happens BEFORE the seam; there is no
    // mutation to authorize when the node carries no claim.
    if (!node.claim || !node.claim.by) {
      return { released: false, node };
    }

    // Build the snapshot + target the policy receives. The snapshot is
    // a fresh view over the read state; plugins cannot mutate it.
    const target = {
      id: node.id,
      kind: node.kind,
      subkind: node.subkind,
      status: node.status,
      claim: { ...(node.claim || {}) },
    };
    const snapshot = {
      state: s,
      nodes: { ...s.nodes },
      edges: s.edges.slice(),
      initiatives: { ...s.initiatives },
    };

    // ADR-008 §"Tabla de resolve" + §3.4: decision contract for
    // task.release is { allow → proceed, deny → POLICY_DENIED,
    // abstain → defaults core }. authorizeAction surfaces deny/throw
    // by throwing; we map allow/abstain to the action-specific path
    // below.
    const decision = await authorizeAction({
      policy,
      action: "task.release",
      actor: as,
      target,
      snapshot,
      projectDir,
      projectConfig: policy ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(
        policy && policy.pluginId ? policy.pluginId : "(unknown)",
        "task.release",
        as,
        decision.reason || "denied by policy",
      );
    }
    // decision is "allow" or "abstain". "allow" skips the owner check
    // (the policy already authorized the actor); "abstain" falls back
    // to the default-core owner check.
    if (decision.decision === "abstain" && node.claim.by !== as) {
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
    await appendWithContext(
      projectDir,
      { agent: as, action: "release", node: id },
      { pluginId },
    );
    return { released: true, node: updated.nodes[id] };
  });
}
