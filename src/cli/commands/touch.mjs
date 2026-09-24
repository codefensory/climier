// `touch <id>` CLI adapter for the canonical task.touch provider.
// The kernel owns locking, state, revisions and logs; this module only maps
// CLI flags to the typed provider request and projects the legacy envelope.
//
// ADR-022 §C (D1): touch is a real revisioned mutation. Only the actor that
// holds the claim may refresh it; domain status never changes.
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { PolicyDenied } from "../../plugins/errors.mjs";
import { taskTouchProvider } from "../../providers/task/touch.mjs";

export const knownFlags = ["as"];

function policyForTouch({ policy, projectDir, agent, id }) {
  return {
    action: "task.touch",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      if (!policy) return { decision: "abstain" };

      const decision = await authorizeAction({
        policy,
        action: "task.touch",
        actor: agent,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
      if (decision.decision === "deny") {
        throw new PolicyDenied(
          policy.pluginId || "(unknown)",
          "task.touch",
          agent,
          decision.reason || "denied by policy",
        );
      }
      return decision;
    },
  };
}

export default async function touch({ statePath, flags = {}, positional = [], projectDir, pluginId }) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "touch: node id required", { field: "id" });
  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "touch");
  const policy = await loadApplicablePolicy({ projectDir: dir });

  const mutation = await mutate({
    projectDir: dir,
    request: { action: "touch", actor: agent, input: { id, actor: agent } },
    provider: taskTouchProvider,
    policyAction: policyForTouch({ policy, projectDir: dir, agent, id }),
    pluginId,
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `touch: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}
