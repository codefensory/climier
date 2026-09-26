// `reopen <id>` CLI adapter for task.reopen / gate.reopen.
// Application Operations selects the provider; the kernel remains the sole
// mutation frontier for locking, revisions, policy and audit persistence.
import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { taskReopenProvider } from "../../providers/task/reopen.mjs";
import { executeRemoteResolvableLifecycle } from "./internal/resolvable-lifecycle-routing.mjs";
import { prepareGateReopen, applyGateReopen } from "../../providers/gate/lifecycle.mjs";

const REGISTRY = bootstrapBuiltins();

export const knownFlags = ["as", "reason"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) {
    return flags.reason.trim();
  }
  return positional.slice(1).join(" ").trim();
}

function providerFor(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  return node && node.subkind === "gate" ? gateReopenAdapterProvider : taskReopenAdapterProvider;
}

const taskReopenAdapterProvider = Object.freeze({
  async prepare(args) {
    const plan = await taskReopenProvider.prepare(args);
    const node = args.snapshot.nodes[args.input.id];
    return {
      ...plan,
      target: { ...plan.target, done_by: node && node.done_by ? node.done_by : null },
      logFields: { note: plan.reason },
    };
  },
  async apply(args) {
    const out = await taskReopenProvider.apply(args);
    args.tx.updateNode(args.plan.target.id, {
      done_by: undefined,
      done_at: undefined,
      note: undefined,
      resolution: undefined,
    });
    return out;
  },
});

const gateReopenAdapterProvider = Object.freeze({
  async prepare(args) {
    const plan = await prepareGateReopen(args);
    const node = args.snapshot.nodes[args.input.id];
    return {
      ...plan,
      target: { ...plan.target, done_by: node && node.done_by ? node.done_by : null },
      logFields: { note: plan.reason },
    };
  },
  async apply(args) {
    const out = await applyGateReopen(args);
    args.tx.updateNode(args.plan.target.id, { resolution: undefined });
    return out;
  },
});

function sourceWithCliProvider(source, id, selectedPolicyAction) {
  return {
    ...source,
    policyAction: selectedPolicyAction,
    registry: {
      lookup(operation) {
        const entry = source.registry.lookup(operation);
        if (!["task.reopen", "gate.reopen"].includes(operation) || !entry) {
          return entry;
        }
        return {
          ...entry,
          provider: {
            async prepare(args) { return providerFor(args.snapshot, id).prepare(args); },
            async apply(args) {
              return (args.plan.target.subkind === "gate"
                ? gateReopenAdapterProvider
                : taskReopenAdapterProvider).apply(args);
            },
          },
        };
      },
    },
  };
}

function policyAction({ policy, projectDir, agent, id }) {
  return {
    action: "task.reopen",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      if (!policy) {
        return { decision: "abstain" };
      }
      const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
      return authorizeAction({
        policy,
        action: "task.reopen",
        actor: agent,
        target: { ...target, done_by: node && node.done_by ? node.done_by : null },
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
    },
  };
}

async function reopenLocally({ dir, agent, id, reason, pluginId, suppliedSource }) {
  const policy = suppliedSource ? null : await loadApplicablePolicy({ projectDir: dir });
  const baseSource = suppliedSource || {
    registry: REGISTRY,
    mutate,
    selectPolicy: async () => policy,
    authorizeAction,
    policyAction: policy ? policyAction({ policy, projectDir: dir, agent, id }) : undefined,
    pluginId,
  };
  const mutation = await executeOperation({
    projectDir: dir,
    actor: agent,
    operation: "task.reopen",
    input: { id, reason, actor: agent },
    source: sourceWithCliProvider(baseSource, id, policy ? policyAction({ policy, projectDir: dir, agent, id }) : null),
    policyActionFromPlan: true,
  });
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `reopen: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}

export default async function reopen({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
  backendClient,
  source: suppliedSource,
}) {
  const id = positional[0];
  if (!id) {
    throwV2("MISSING_FIELD", "reopen: node id required", { field: "id" });
  }
  const reason = readReason(flags, positional);
  const agent = resolveAgent(flags, "reopen");
  const dir = projectDir || statePath;
  const remote = await executeRemoteResolvableLifecycle({
    backendClient, actor: agent, verb: "reopen", command: "reopen", id, input: { id, reason },
  });
  if (remote) {
    return { node: remote.node };
  }
  return reopenLocally({ dir, agent, id, reason, pluginId, suppliedSource });
}
