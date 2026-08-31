// `restore` CLI adapter for the trusted kernel state operation.
// The kernel owns snapshot validation, locking, pre-restore snapshots, the
// atomic state replacement and the restore log entry. This module maps CLI
// arguments and projects the established output shape.
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../../contracts/agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { restoreState } from "../../kernel/state-operations.mjs";

export const knownFlags = ["as"];

function policyForRestore({ policy, projectDir, actor }) {
  if (!policy) return null;
  return {
    action: "state.restore",
    pluginId: policy.pluginId,
    decide: async ({ snapshot, target, action }) => authorizeAction({
      policy,
      action,
      actor,
      // The kernel snapshot also contains raw/existence bookkeeping used by
      // its trusted operation. Keep those internal fields out of the policy
      // contract used by the command.
      snapshot: {
        state: snapshot.state,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        initiatives: snapshot.initiatives,
      },
      target,
      projectDir,
      projectConfig: policy.projectConfig || {},
    }),
  };
}

export default async function restore({ statePath, flags = {}, positional = [], projectDir, pluginId }) {
  const [snapshotId] = positional;
  if (!snapshotId || typeof snapshotId !== "string") {
    throwV2("MISSING_FIELD", "restore: snapshot id required", { field: "id" });
  }

  const dir = projectDir || statePath;
  const actor = resolveAgent(flags, "restore");
  const policy = await loadApplicablePolicy({ projectDir: dir });
  const mutation = await restoreState({
    projectDir: dir,
    snapshotId,
    actor,
    policyAction: policyForRestore({ policy, projectDir: dir, actor }),
    pluginId,
  });

  return mutation.result;
}
