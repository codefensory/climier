// `take <id>` CLI adapter for the canonical task.take provider.
// The kernel owns locking, state, revisions and logs; this module only maps
// CLI flags to the typed provider request and projects the legacy envelope.
import { mutate } from "../kernel/mutate.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";
import { taskTakeProvider } from "../providers/task/take.mjs";
import { statusOfV2 } from "../providers/task/derivation.mjs";

export const knownFlags = ["as", "initiative", "domain", "tag"];

const TAKEOVER_ABSTAIN = "POLICY_TAKEOVER_ABSTAIN";

function takeoverAbstained(id, owner) {
  const error = new Error(`take: node ${id} is claimed by ${owner}`);
  error.code = TAKEOVER_ABSTAIN;
  error.details = { id, owner };
  return error;
}

const taskTakeAdapterProvider = Object.freeze({
  async prepare(args) {
    try {
      return await taskTakeProvider.prepare(args);
    } catch (error) {
      // The provider reports its domain failure as soon as it sees the open
      // node. Project the derived status expected by the CLI contract for
      // blocked and backlog tasks without adding persistence to the adapter.
      if (error && error.code === "NOT_READY" && args && args.snapshot && args.input) {
        const status = statusOfV2(args.snapshot.state || args.snapshot, args.input.id);
        if (status !== "unknown" && error.details && error.details.status !== status) {
          throwV2("NOT_READY", `take: node ${args.input.id} is ${status}, not ready`, {
            id: args.input.id,
            status,
          });
        }
      }
      throw error;
    }
  },
  apply: taskTakeProvider.apply,
});

function policyForTake({ policy, projectDir, agent, id, snapshotNode }) {
  return {
    action: "task.take",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      // Keep the complete snapshot node for the legacy `{ node }` projection,
      // including when kernel.mutate detects an idempotent operation.
      if (snapshot && snapshot.nodes && snapshot.nodes[id]) {
        snapshotNode.value = snapshot.nodes[id];
      }

      const takeover = target && target.takeover === true;
      // A same-actor take is idempotent and must not invoke a policy seam.
      if (!takeover && target && target.status === "in_progress") {
        return { decision: "abstain" };
      }
      // Without an applicable policy, the core still refuses a takeover:
      // only an explicit policy allow may replace another actor's claim.
      if (!policy) {
        if (takeover) {
          throw takeoverAbstained(id, target.previous_owner);
        }
        return { decision: "abstain" };
      }

      const action = takeover ? "task.takeover" : "task.take";
      const decision = await authorizeAction({
        policy,
        action,
        actor: agent,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
      if (decision.decision === "deny") {
        // Throw here rather than returning deny so takeover errors retain
        // their dynamic policy action; kernel request.action is the legacy
        // log action (`take`).
        throw new PolicyDenied(
          policy.pluginId || "(unknown)",
          action,
          agent,
          decision.reason || "denied by policy",
        );
      }
      if (takeover && decision.decision === "abstain") {
        throw takeoverAbstained(id, target.previous_owner);
      }
      return decision;
    },
  };
}

export default async function take({ positional = [], flags = {}, projectDir, statePath, pluginId }) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "take: node id required", { field: "id" });
  const agent = resolveAgent(flags, "take");
  const dir = projectDir || statePath;
  const policy = await loadApplicablePolicy({ projectDir: dir });
  const snapshotNode = { value: null };

  const input = { id, actor: agent };
  let mutation;
  try {
    mutation = await mutate({
      projectDir: dir,
      request: { action: "take", actor: agent, input },
      provider: taskTakeAdapterProvider,
      policyAction: policyForTake({ policy, projectDir: dir, agent, id, snapshotNode }),
      pluginId,
    });
  } catch (error) {
    if (error && error.code === TAKEOVER_ABSTAIN) {
      throwV2("ALREADY_CLAIMED", error.message, error.details);
    }
    throw error;
  }

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  const node = updated ? updated.node : snapshotNode.value;
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `take: kernel did not return node ${id}`, { id });
  }
  return {
    node,
    context: {
      derived_status: node.status,
      revision: node.revision,
      claim: node.claim || null,
      blocking: [],
      knowledge: [],
    },
    freshly_claimed: mutation.result ? mutation.result.freshly_claimed === true : false,
  };
}
