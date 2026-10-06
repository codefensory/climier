
import { executeOperation } from "../../application/operations/index.ts";
import { mutate } from "../../kernel/mutate.ts";
import { getOperationSource } from "../../operation-source.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";
import { taskTakeProvider } from "../../providers/task/take.ts";
import { statusOfV2 } from "../../providers/task/derivation.ts";
import { executeRemoteTask, requireRemoteTask, throwMissingRemoteNode } from "./internal/task-routing.ts";
import type { CliMutation, CommandContext } from "./contracts.ts";

export const knownFlags = ["as"];

function hasReadinessContext(error, args) {
  return Boolean(error && error.code === "NOT_READY" && args && args.snapshot && args.input);
}

function restoreHistoricalReadiness(error, args) {
  if (!hasReadinessContext(error, args)) {
    return;
  }
  const status = statusOfV2(args.snapshot.state || args.snapshot, args.input.id);
  if (status !== "unknown" && error.details && error.details.status !== status) {
    throwV2("NOT_READY", `take: node ${args.input.id} is ${status}, not ready`, {
      id: args.input.id,
      status,
    });
  }
}

async function prepareCliTake(args, snapshotNode) {
  try {
    const plan = await taskTakeProvider.prepare(args);
    const node = args.snapshot?.nodes?.[args.input?.id];
    if (node) {
      snapshotNode.value = node;
    }
    return plan;
  } catch (error) {

    restoreHistoricalReadiness(error, args);
    throw error;
  }
}

function withCliTakeProvider(source, snapshotNode) {
  const provider = Object.freeze({
    prepare: (args) => prepareCliTake(args, snapshotNode),
    apply: taskTakeProvider.apply,
  });
  return {
    ...source,
    registry: {
      ...source.registry,
      lookup(id) {
        const entry = source.registry.lookup(id);
        return id === "task.take" && entry ? { ...entry, provider } : entry;
      },
    },
  };
}

async function takeSource(source, snapshotNode, pluginId) {
  const selectedSource = source || await getOperationSource();
  const operationSource = typeof selectedSource.mutate === "function" ? selectedSource : { ...selectedSource, mutate };
  const originalAuthorize = operationSource.authorizeAction || (async () => ({ decision: "abstain" }));
  return {
    ...withCliTakeProvider(operationSource, snapshotNode),
    pluginId: operationSource.pluginId || pluginId,
    async authorizeAction(args) {
      if (args.target?.status === "in_progress" && !args.target.takeover) {
        return { decision: "abstain" };
      }
      return originalAuthorize(args);
    },
  };
}

async function takeRemotely({ backendClient, id, agent }) {
  if (backendClient && backendClient.type === "remote") {
    await requireRemoteTask(backendClient, id, "take");
  }
  const remote = await executeRemoteTask({
    backendClient, actor: agent, operation: "task.take", command: "take", id, input: { id },
  });
  if (!remote) {
    return null;
  }
  const node = remote.node;
  if (!node) {
    throwMissingRemoteNode("take", id);
  }
  return {
    node,
    context: { derived_status: node!.status, revision: node!.revision, claim: node!.claim || null, blocking: [], knowledge: [] },
    freshly_claimed: remote.mutation.result ? remote.mutation.result.freshly_claimed === true : false,
  };
}

async function takeLocally({ id, agent, dir, source, pluginId }) {
  const snapshotNode = { value: null };
  const mutation = await executeOperation({
    projectDir: dir, actor: agent, operation: "task.take", input: { id, actor: agent },
    // The source keeps this adapter's narrow provider/policy compatibility seam.
    policyActionFromPlan: true, source: await takeSource(source, snapshotNode, pluginId),
    // source: takeSource(...) is intentionally retained as the adapter contract.
  }) as CliMutation;
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  const node = updated ? updated.node : snapshotNode.value;
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `take: kernel did not return node ${id}`, { id });
  }
  return {
    node,
    context: { derived_status: node!.status, revision: node!.revision, claim: node!.claim || null, blocking: [], knowledge: [] },
    freshly_claimed: mutation.result ? mutation.result.freshly_claimed === true : false,
  };
}

export default async function take({ positional, flags, projectDir, statePath, pluginId, backendClient, source }: CommandContext) {
  const id = positional[0];
  if (!id) {
    throwV2("MISSING_FIELD", "take: node id required", { field: "id" });
  }
  const agent = resolveAgent(flags, "take");
  const dir = projectDir || statePath;
  const remote = await takeRemotely({ backendClient, id, agent });
  if (remote) {
    return remote;
  }
  return takeLocally({ id, agent, dir, source, pluginId });
}
