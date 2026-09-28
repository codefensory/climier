
// atomic persistence; this module only handles CLI-specific setup and output.
import { stateFile, ensureProjectMeta } from "../../storage/state.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { initState } from "../../kernel/state-operations.mjs";

export const knownFlags = ["force", "as"];

function policyForInit({ policy, projectDir, actor }) {
  if (!policy) {return null;}
  return {
    action: "state.init_force",
    pluginId: policy.pluginId,
    decide: async ({ snapshot, target, action }) => authorizeAction({
      policy,
      action,
      actor,

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

async function initRemote(backendClient, force) {
  if (force) {
    const error = new Error("init: --force is not supported by the remote backend");
    error.code = "REMOTE_UNSUPPORTED_OPERATION";
    error.details = { command: "init", option: "--force" };
    throw error;
  }
  const result = await backendClient.init();
  const response = { ok: true, seeded: result?.seeded ?? null, file: null };
  if (backendClient.insecureRemoteHttp === true) {
    response.warnings = [{
      kind: "insecure-remote-http",
      severity: "warning",
      message: "init: remote HTTP is enabled by CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true; bearer credentials are sent without transport encryption. Internal trusted networks only.",
    }];
  }
  return response;
}

async function initLocal({ dir, force, flags, pluginId }) {
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

  if (!force) {await ensureProjectMeta(dir);}
  return {
    ok: true,
    seeded: mutation.result ? mutation.result.seeded : null,
    file: stateFile(dir),
  };
}

export default async function init({ statePath, flags = {}, projectDir, pluginId, backendClient }) {
  const dir = projectDir || statePath;
  const force = Boolean(flags.force);
  if (backendClient?.type === "remote") {return initRemote(backendClient, force);}
  return initLocal({ dir, force, flags, pluginId });
}
