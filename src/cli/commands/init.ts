
// atomic persistence; this module only handles CLI-specific setup and output.
import { stateFile, ensureProjectMeta } from "../../storage/state.ts";
import { resolveAgent } from "../actor.ts";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.ts";
import { initState } from "../../kernel/state-operations.ts";
import type { CliBackendClient, CliFlags, CommandContext } from "./contracts.ts";

export const knownFlags = ["force", "as"];

function policyForInit({ policy, projectDir, actor }: { policy: Awaited<ReturnType<typeof loadApplicablePolicy>>; projectDir: string; actor: string | undefined }) {
  if (!policy) {return null;}
  return {
    action: "state.init_force",
    pluginId: policy.pluginId,
    decide: async ({ snapshot, target, action }) => authorizeAction({
      policy,
      action,
      actor: actor as string,

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

async function initRemote(backendClient: CliBackendClient, force: boolean) {
  if (force) {
    const error = new Error("init: --force is not supported by the remote backend");
    error.code = "REMOTE_UNSUPPORTED_OPERATION";
    error.details = { command: "init", option: "--force" };
    throw error;
  }
  const insecureRemoteHttp = backendClient.insecureRemoteHttp === true;
  const result = await backendClient.init();
  const response: { ok: boolean; seeded: unknown; file: null; warnings?: Array<Record<string, string>> } = { ok: true, seeded: result?.seeded ?? null, file: null };
  if (insecureRemoteHttp) {
    response.warnings = [{
      kind: "insecure-remote-http",
      severity: "warning",
      message: "init: remote HTTP is enabled by CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true; bearer credentials are sent without transport encryption. Internal trusted networks only.",
    }];
  }
  return response;
}

async function initLocal({ dir, force, flags, pluginId }: { dir: string; force: boolean; flags: CliFlags; pluginId?: string }) {
  let actor;
  let policy: Awaited<ReturnType<typeof loadApplicablePolicy>> = null;
  if (force) {
    // Preserve the force-init preflight order: missing identity must fail
    // before project metadata or policy discovery has any side effect.
    actor = resolveAgent(flags, "init");
    await ensureProjectMeta(dir);
    policy = await loadApplicablePolicy({ projectDir: dir });
  }
  const mutation = await initState({    projectDir: dir,
    force,
    actor,
    policyAction: policyForInit({ policy, projectDir: dir, actor }),
    pluginId,
  }) as { result?: { seeded?: unknown } };

  if (!force) {await ensureProjectMeta(dir);}
  return {
    ok: true,
    seeded: mutation.result ? mutation.result.seeded : null,
    file: stateFile(dir),
  };
}

export default async function init({ statePath, flags = {}, projectDir, pluginId, backendClient }: CommandContext) {
  const dir = projectDir || statePath;
  const force = Boolean(flags.force);
  if (backendClient?.type === "remote") {return initRemote(backendClient, force);}
  return initLocal({ dir, force, flags, pluginId });
}
