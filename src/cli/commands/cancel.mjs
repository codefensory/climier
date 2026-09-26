// `cancel <id>` CLI adapter for task.cancel / gate.cancel.
// Application Operations selects the provider; the kernel remains the sole
// mutation frontier for locking, revisions, policy and audit persistence.
import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { taskCancelProvider } from "../../providers/task/cancel.mjs";
import { executeRemoteResolvableLifecycle } from "./internal/resolvable-lifecycle-routing.mjs";
import { prepareGateCancel, applyGateCancel } from "../../providers/gate/lifecycle.mjs";

const REGISTRY = bootstrapBuiltins();

export const knownFlags = ["as", "reason"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) {return flags.reason.trim();}
  return positional.slice(1).join(" ").trim();
}

function providerFor(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  return node && node.subkind === "gate" ? gateCancelAdapterProvider : taskCancelAdapterProvider;
}

const taskCancelAdapterProvider = Object.freeze({
  async prepare(args) {
    const plan = await taskCancelProvider.prepare(args);
    const node = args.snapshot.nodes[args.input.id];
    return {
      ...plan,
      target: { ...plan.target, claim: node && node.claim ? { ...node.claim } : null },
      logFields: { note: plan.reason },
    };
  },
  apply: taskCancelProvider.apply,
});

const gateCancelAdapterProvider = Object.freeze({
  async prepare(args) {
    const plan = await prepareGateCancel(args);
    const node = args.snapshot.nodes[args.input.id];
    return {
      ...plan,
      target: { ...plan.target, claim: node && node.claim ? { ...node.claim } : null },
      logFields: { note: plan.reason },
    };
  },
  apply: applyGateCancel,
});

function sourceWithCliProvider(source, id, selectedPolicyAction) {
  return {
    ...source,
    policyAction: selectedPolicyAction,
    registry: {
      lookup(operation) {
        const entry = source.registry.lookup(operation);
        if (!["task.cancel", "gate.cancel"].includes(operation) || !entry) {return entry;}
        return {
          ...entry,
          provider: {
            async prepare(args) { return providerFor(args.snapshot, id).prepare(args); },
            async apply(args) {
              return (args.plan.target.subkind === "gate"
                ? gateCancelAdapterProvider
                : taskCancelAdapterProvider).apply(args);
            },
          },
        };
      },
    },
  };
}

function policyAction({ policy, projectDir, agent, id }) {
  return {
    action: "task.cancel",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      if (!policy) {return { decision: "abstain" };}
      const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
      return authorizeAction({
        policy,
        action: "task.cancel",
        actor: agent,
        target: { ...target, claim: node && node.claim ? { ...node.claim } : null },
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
    },
  };
}

function cancelSource({ suppliedSource, policy, dir, agent, id, pluginId }) {
  const baseSource = suppliedSource || {
    registry: REGISTRY,
    mutate,
    selectPolicy: async () => policy,
    authorizeAction,
    policyAction: policy ? policyAction({ policy, projectDir: dir, agent, id }) : undefined,
    pluginId,
  };
  return sourceWithCliProvider(baseSource, id, policy ? policyAction({ policy, projectDir: dir, agent, id }) : null);
}

async function cancelRemote(backendClient, agent, id, reason) {
  const remote = await executeRemoteResolvableLifecycle({
    backendClient, actor: agent, verb: "cancel", command: "cancel", id, input: { id, reason },
  });
  return remote ? { node: remote.node } : null;
}

function canceledNode(mutation, id) {
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `cancel: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}

export default async function cancel({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
  backendClient,
  source: suppliedSource,
}) {
  const id = positional[0];
  if (!id) {throwV2("MISSING_FIELD", "cancel: node id required", { field: "id" });}
  const reason = readReason(flags, positional);
  const agent = resolveAgent(flags, "cancel");
  const dir = projectDir || statePath;
  const remote = await cancelRemote(backendClient, agent, id, reason);
  if (remote) {return remote;}
  const policy = suppliedSource ? null : await loadApplicablePolicy({ projectDir: dir });
  const mutation = await executeOperation({
    projectDir: dir,
    actor: agent,
    operation: "task.cancel",
    input: { id, reason, actor: agent },
    source: cancelSource({ suppliedSource, policy, dir, agent, id, pluginId }),
    policyActionFromPlan: true,
  });
  return canceledNode(mutation, id);
}
