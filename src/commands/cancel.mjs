// `cancel <id>` CLI adapter for task.cancel / gate.cancel.
// The kernel owns locking, state, revisions and logs; this module only maps
// CLI flags to the typed provider request and projects the legacy envelope.
import { mutate } from "../kernel/mutate.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../contracts/agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../plugins/policy.mjs";
import { taskCancelProvider } from "../providers/task/cancel.mjs";
import {
  gateCancelProvider,
  prepareGateCancel,
  applyGateCancel,
} from "../providers/gate/lifecycle.mjs";

export const knownFlags = ["as", "reason"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) return flags.reason.trim();
  return positional.slice(1).join(" ").trim();
}

function providerFor(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  return node && node.subkind === "gate" ? gateCancelAdapterProvider : taskCancelAdapterProvider;
}

const taskCancelAdapterProvider = Object.freeze({
  async prepare(args) {
    const plan = await taskCancelProvider.prepare(args);
    return { ...plan, logFields: { note: plan.reason } };
  },
  apply: taskCancelProvider.apply,
});

const gateCancelAdapterProvider = Object.freeze({
  async prepare(args) {
    const plan = await prepareGateCancel(args);
    return { ...plan, logFields: { note: plan.reason } };
  },
  apply: applyGateCancel,
});

function policyAction({ policy, projectDir, agent, id }) {
  return {
    action: "task.cancel",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      if (!policy) return { decision: "abstain" };
      const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
      return authorizeAction({
        policy,
        action: "task.cancel",
        actor: agent,
        target: {
          ...target,
          claim: node && node.claim ? { ...node.claim } : null,
        },
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
    },
  };
}

export default async function cancel({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
}) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "cancel: node id required", { field: "id" });
  const reason = readReason(flags, positional);
  const agent = resolveAgent(flags, "cancel");
  const dir = projectDir || statePath;
  const policy = await loadApplicablePolicy({ projectDir: dir });

  const mutation = await mutate({
    projectDir: dir,
    request: {
      action: "cancel",
      actor: agent,
      input: { id, reason, actor: agent },
    },
    provider: {
      async prepare(args) {
        return providerFor(args.snapshot, id).prepare(args);
      },
      async apply(args) {
        return (args.plan.target.subkind === "gate"
          ? gateCancelAdapterProvider
          : taskCancelAdapterProvider).apply(args);
      },
    },
    policyAction: policyAction({ policy, projectDir: dir, agent, id }),
    pluginId,
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `cancel: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}
