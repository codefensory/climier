// `take <id>` CLI adapter for the canonical task.take operation.
// Application Operations selects the provider; the kernel remains the sole
// mutation frontier for locking, policy, revisions, audit and persistence.
import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { taskTakeProvider } from "../../providers/task/take.mjs";
import { statusOfV2 } from "../../providers/task/derivation.mjs";
import { executeRemoteTask, requireRemoteTask, throwMissingRemoteNode } from "./internal/task-routing.mjs";

const REGISTRY = bootstrapBuiltins();

// `take <id>` names its target positionally and only carries the actor.
// Filters that were accepted and ignored are unknown flags now (ADR-038).
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
    // Preserve the CLI's historical derived readiness projection.
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

function takeSource(source, snapshotNode, pluginId) {
  const operationSource = source || {
    registry: REGISTRY,
    mutate,
    loadApplicablePolicy,
    authorizeAction,
  };
  const originalAuthorize = operationSource.authorizeAction || authorizeAction;
  return {
    ...withCliTakeProvider(operationSource, snapshotNode),
    pluginId: operationSource.pluginId || pluginId,
    async authorizeAction(args) {
      // The provider's fresh plan distinguishes idempotence from takeover.
      // Identity (--as) is never authorization, and same-owner repeats do not
      // invoke policy or create a mutation/audit entry.
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
    context: { derived_status: node.status, revision: node.revision, claim: node.claim || null, blocking: [], knowledge: [] },
    freshly_claimed: remote.mutation.result ? remote.mutation.result.freshly_claimed === true : false,
  };
}

async function takeLocally({ id, agent, dir, source, pluginId }) {
  const snapshotNode = { value: null };
  const mutation = await executeOperation({
    projectDir: dir, actor: agent, operation: "task.take", input: { id, actor: agent },
    policyActionFromPlan: true, source: takeSource(source, snapshotNode, pluginId),
  });
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  const node = updated ? updated.node : snapshotNode.value;
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `take: kernel did not return node ${id}`, { id });
  }
  return {
    node,
    context: { derived_status: node.status, revision: node.revision, claim: node.claim || null, blocking: [], knowledge: [] },
    freshly_claimed: mutation.result ? mutation.result.freshly_claimed === true : false,
  };
}

export default async function take({ positional = [], flags = {}, projectDir, statePath, pluginId, backendClient, source } = {}) {
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
