// `release <id>` CLI adapter for the canonical task.release provider.
// The kernel owns locking, state, revisions and logs; this module only maps
// CLI flags to the typed provider request and projects the legacy envelope.
import { mutate } from "../kernel/mutate.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../plugins/policy.mjs";
import { PolicyDenied } from "../plugins/errors.mjs";
import { taskReleaseProvider } from "../providers/task/release.mjs";

export const knownFlags = ["as"];

function policyForRelease({ policy, projectDir, agent, id, snapshotNode }) {
  return {
    action: "task.release",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      // Keep the complete snapshot node for the legacy `{ node }` projection,
      // including when kernel.mutate detects an idempotent operation.
      if (snapshot && snapshot.nodes && snapshot.nodes[id]) {
        snapshotNode.value = snapshot.nodes[id];
      }
      // A task with no claim is idempotent and must not invoke a policy seam.
      if (!target || target.had_claim !== true) return { decision: "abstain" };
      if (!policy) return { decision: "abstain" };

      const decision = await authorizeAction({
        policy,
        action: "task.release",
        actor: agent,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
      if (decision.decision === "deny") {
        throw new PolicyDenied(
          policy.pluginId || "(unknown)",
          "task.release",
          agent,
          decision.reason || "denied by policy",
        );
      }
      return decision;
    },
  };
}

export default async function release({ statePath, flags = {}, positional = [], projectDir, pluginId }) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "release: node id required", { field: "id" });
  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "release");
  const policy = await loadApplicablePolicy({ projectDir: dir });
  const snapshotNode = { value: null };

  const mutation = await mutate({
    projectDir: dir,
    request: { action: "release", actor: agent, input: { id, actor: agent } },
    provider: taskReleaseProvider,
    policyAction: policyForRelease({ policy, projectDir: dir, agent, id, snapshotNode }),
    pluginId,
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  const node = updated ? updated.node : snapshotNode.value;
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `release: kernel did not return node ${id}`, { id });
  }
  return {
    released: mutation.result ? mutation.result.released === true : false,
    node,
  };
}
