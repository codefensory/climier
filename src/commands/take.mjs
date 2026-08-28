// `take <id>` idempotently claims exactly one v2 task.
// Legacy selection flags remain accepted but are ignored.
//
// T-plugin-policy-seam-lifecycle / ADR-008 §"Tabla de take":
//   - task free                       → action `task.take`; allow/deny/abstain
//                                       per the matrix in §3.4.
//   - claim by same actor             → idempotent (no seam invoked, no mutation).
//   - claim by another actor          → action `task.takeover`; allow replaces
//                                       claim + previous_owner; deny → POLICY_DENIED;
//                                       abstain → ALREADY_CLAIMED.
//
// The action is selected INSIDE the lock, AFTER reading the state, so
// the decision is always based on the freshest snapshot. The selection
// logic does NOT inspect actor strings (no more `agent === "orchestrator"`).
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { appendWithContext } from "../log.mjs";
import { blockingForNode, statusOfV2 } from "../v2.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";

export const knownFlags = ["as", "initiative", "domain", "tag"];

function buildContext(state, id) {
  const node = state.nodes[id];
  return {
    derived_status: statusOfV2(state, id),
    revision: node.revision,
    claim: node.claim || null,
    blocking: blockingForNode(state, id),
    knowledge: [],
  };
}

export default async function take({ positional = [], flags = {}, projectDir, statePath, pluginId }) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "take: node id required", { field: "id" });
  const agent = resolveAgent(flags, "take");
  const dir = projectDir || statePath;

  // ADR-007 §"Discovery global" item 5: re-load policy every call so
  // install/uninstall changes are observed immediately.
  const policy = await loadApplicablePolicy({ projectDir: dir });

  return withLock(dir, async () => {
    const state = await readState(dir);
    if (!state) {
      throwV2("NODE_NOT_FOUND", "take: state file missing; run `climier init` first", { projectDir: dir });
    }

    const node = state.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `take: node ${id} not found`, { id });
    if (node.kind !== "resolvable" || node.subkind !== "task") {
      throwV2("NOT_CLAIMABLE", `take: node ${id} is not a task`, {
        id,
        kind: node.kind,
        subkind: node.subkind,
      });
    }

    const status = statusOfV2(state, id);
    const owner = node.claim && node.claim.by;

    // Idempotent: same actor claims the in-progress task. No seam, no
    // mutation — matches ADR-008 §"Tabla de take" (mismo actor → sin
    // mutación, todas las decisiones son idempotentes).
    if (status === "in_progress" && owner === agent) {
      return { node, context: buildContext(state, id), freshly_claimed: false };
    }

    // Build snapshot + target for the seam. ADR-008 §"Invariantes core":
    // a fresh task may only receive ONE claim winner under concurrency.
    // The action classification happens inside the lock so the policy
    // sees the snapshot and the current claim owner.
    const target = {
      id: node.id,
      kind: node.kind,
      subkind: node.subkind,
      status: node.status,
      claim: node.claim ? { ...node.claim } : null,
    };
    const snapshot = {
      state,
      nodes: { ...state.nodes },
      edges: state.edges.slice(),
      initiatives: { ...state.initiatives },
    };

    let action;
    let takeover = false;
    if (status === "in_progress" && owner && owner !== agent) {
      // Another actor currently holds the claim: this is a takeover
      // attempt. ADR-008 §"Tabla de take" classifies this as the
      // `task.takeover` action regardless of the actor identity.
      action = "task.takeover";
      takeover = true;
    } else if (status === "ready") {
      action = "task.take";
    } else {
      // Status is not `ready` and we are not already the owner: NOT_READY.
      // The seam is not invoked because there is nothing to authorize
      // before the status check.
      throwV2("NOT_READY", `take: node ${id} is ${status}, not ready`, { id, status });
    }

    const decision = await authorizeAction({
      policy,
      action,
      actor: agent,
      target,
      snapshot,
      projectDir: dir,
      projectConfig: policy ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(
        policy && policy.pluginId ? policy.pluginId : "(unknown)",
        action,
        agent,
        decision.reason || "denied by policy",
      );
    }

    if (action === "task.takeover") {
      if (decision.decision === "abstain") {
        // ADR-008 §"Tabla de take": takeover + abstain → ALREADY_CLAIMED.
        // The default-core behaviour is to refuse the takeover because
        // no policy chose to authorize it.
        throwV2(
          "ALREADY_CLAIMED",
          `take: node ${id} is claimed by ${owner}`,
          { id, owner },
        );
      }
      // allow → fall through to mutation with takeover=true.
    }
    // task.take + allow/abstain → proceed (defaults core lets the
    // claim happen; allow is identical from the host's perspective).

    const at = new Date().toISOString();
    const updated = await updateState(dir, (next) => {
      const target = next.nodes[id];
      target.claim = { by: agent, at };
      target.status = "in_progress";
      target.revision = (target.revision || 0) + 1;
      return next;
    });
    await appendWithContext(
      dir,
      {
        agent,
        action: "take",
        node: id,
        ...(takeover ? { previous_owner: owner } : {}),
      },
      { pluginId },
    );

    return {
      node: updated.nodes[id],
      context: buildContext(updated, id),
      freshly_claimed: true,
    };
  });
}
