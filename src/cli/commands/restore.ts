
// atomic state replacement and the restore log entry. This module maps CLI

import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.ts";
import { restoreState } from "../../kernel/state-operations.ts";
import type { CliMutation, CommandContext } from "./contracts.ts";

export const knownFlags = ["as"];

function policyForRestore({ policy, projectDir, actor }) {
  if (!policy) {return null;}
  return {
    action: "state.restore",
    pluginId: policy.pluginId,
    decide: async ({ snapshot, target, action }) => authorizeAction({
      policy,
      action,
      actor,

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

export default async function restore({ statePath, flags, positional, projectDir, pluginId }: CommandContext) {
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
  }) as CliMutation;

  return mutation.result;
}
