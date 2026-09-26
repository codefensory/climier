// `release <id>` CLI adapter for the canonical task.release operation.
// The operation bridge selects the local or remote mutation frontier; this
// module only maps CLI input and projects the legacy envelope.
import { bootstrapBuiltins, createBackendClient, createOperationBridge } from "../../application/operations/index.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { PolicyDenied } from "../../plugins/errors.mjs";
import { executeRemoteTask, requireRemoteTask, throwMissingRemoteNode } from "./internal/task-routing.mjs";

export const knownFlags = ["as"];

async function localReleaseBackend({ backendClient, projectDir, projectConfig, source, pluginId, id, snapshotNode }) {
  if (backendClient?.type !== "local" || backendClient.operationSource === undefined) return backendClient;
  const operationSource = source || await backendClient.operationSource;
  if (!operationSource?.registry || typeof operationSource.mutate !== "function") return backendClient;

  const registry = {
    ...operationSource.registry,
    lookup(operation) {
      const entry = operationSource.registry.lookup(operation);
      if (operation !== "task.release" || !entry) return entry;
      const provider = entry.provider || entry;
      return {
        ...entry,
        provider: {
          ...provider,
          async prepare(args) {
            snapshotNode.value = args.snapshot?.nodes?.[id] || null;
            return provider.prepare(args);
          },
        },
      };
    },
  };
  const releaseSource = {
    ...operationSource,
    registry,
    mutate(args) {
      return operationSource.mutate({ ...args, request: { ...args.request, action: "release" } });
    },
    async authorizeAction(args) {
      if (args.action !== "task.release" || args.target?.had_claim !== true) return { decision: "abstain" };
      const decision = await operationSource.authorizeAction(args);
      if (decision.decision === "deny") {
        throw new PolicyDenied(
          args.policy.pluginId || "(unknown)",
          "task.release",
          args.actor,
          decision.reason || "denied by policy",
        );
      }
      return decision;
    },
    ...(pluginId ? { pluginId } : {}),
  };
  return createBackendClient({ projectDir, projectConfig, source: releaseSource });
}

export default async function release({ statePath, flags = {}, positional = [], projectDir, projectConfig, pluginId, backendClient, source }) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "release: node id required", { field: "id" });
  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "release");
  if (backendClient && backendClient.type === "remote") await requireRemoteTask(backendClient, id, "release");
  const remote = await executeRemoteTask({
    backendClient,
    actor: agent,
    operation: "task.release",
    command: "release",
    id,
    input: { id },
  });
  if (remote) {
    if (!remote.node) throwMissingRemoteNode("release", id);
    return { released: remote.mutation.result?.released === true, node: remote.node };
  }

  const snapshotNode = { value: null };
  const selectedClient = backendClient || createBackendClient({ projectDir: dir, projectConfig, source });
  const bridgeClient = await localReleaseBackend({ backendClient: selectedClient, projectDir: dir, projectConfig, source, pluginId, id, snapshotNode });
  const mutation = await createOperationBridge({ backendClient: bridgeClient }).executeOperation({
    actor: agent,
    operation: "task.release",
    input: { id, actor: agent },
  });
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  const node = updated ? updated.node : snapshotNode.value || mutation.result?.node || null;
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `release: kernel did not return node ${id}`, { id });
  }
  return {
    released: mutation.result ? mutation.result.released === true : false,
    node,
  };
}
