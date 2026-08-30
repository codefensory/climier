// `init` CLI adapter for the trusted kernel state operations.
// The kernel owns state inspection, locking, snapshots, policy execution and
// atomic persistence; this module only handles CLI-specific setup and output.
import { stateFile, ensureProjectMeta } from "../storage/state.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../plugins/policy.mjs";
import { initState } from "../kernel/state-operations.mjs";

export const knownFlags = ["force", "as"];

function policyForInit({ policy, projectDir, actor }) {
  if (!policy) return null;
  return {
    action: "state.init_force",
    pluginId: policy.pluginId,
    decide: async ({ snapshot, target, action }) => authorizeAction({
      policy,
      action,
      actor,
      // Preserve the legacy policy target shape. The kernel needs a stable
      // string target id internally, while state has no node id of its own.
      target: { ...target, id: null },
      snapshot: {
        state: snapshot.state,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        initiatives: snapshot.initiatives,
      },
      projectDir,
      projectConfig: policy.projectConfig || {},
    }),
  };
}

export default async function init({ statePath, flags = {}, projectDir, pluginId }) {
  const dir = projectDir || statePath;
  const force = Boolean(flags.force);

  let actor;
  let policy = null;
  if (force) {
    // Preserve the force-init preflight order: missing identity must fail
    // before project metadata or policy discovery has any side effect.
    actor = resolveAgent(flags, "init");
    await ensureProjectMeta(dir);
    policy = await loadApplicablePolicy({ projectDir: dir });
  }

  const mutation = await initState({
    projectDir: dir,
    force,
    actor,
    policyAction: policyForInit({ policy, projectDir: dir, actor }),
    pluginId,
  });

  // Plain init can bootstrap using the deterministic fallback project id;
  // create repo metadata only after the kernel accepts the operation so a
  // refusal on an existing state remains side-effect free.
  if (!force) await ensureProjectMeta(dir);

  return {
    ok: true,
    seeded: mutation.result ? mutation.result.seeded : null,
    file: stateFile(dir),
  };
}
