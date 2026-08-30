// `reopen <id>` CLI adapter for task.reopen / gate.reopen.
// The kernel owns locking, state, revisions and logs; this module only maps
// CLI flags to the typed provider request and projects the legacy envelope.
import { mutate } from "../kernel/mutate.mjs";
import { throwV2 } from "../contracts/errors.mjs";
import { resolveAgent } from "../contracts/agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../plugins/policy.mjs";
import { taskReopenProvider } from "../providers/task/reopen.mjs";
import {
  gateReopenProvider,
  prepareGateReopen,
  applyGateReopen,
} from "../providers/gate/lifecycle.mjs";

export const knownFlags = ["as", "reason"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) return flags.reason.trim();
  return positional.slice(1).join(" ").trim();
}

function providerFor(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  return node && node.subkind === "gate" ? gateReopenAdapterProvider : taskReopenAdapterProvider;
}

const taskReopenAdapterProvider = Object.freeze({
  async prepare(args) {
    const plan = await taskReopenProvider.prepare(args);
    return { ...plan, logFields: { note: plan.reason } };
  },
  async apply(args) {
    const out = await taskReopenProvider.apply(args);
    // transaction.updateNode is merge-based. Explicitly clear terminal
    // fields so the persisted projection matches the legacy command, which
    // removed done_by/done_at/note/resolution on reopen.
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
    return { ...plan, logFields: { note: plan.reason } };
  },
  async apply(args) {
    const out = await applyGateReopen(args);
    // Gate providers expose a typed null sentinel for pure draft tests; the
    // legacy CLI persisted this field as absent when reopening a gate.
    args.tx.updateNode(args.plan.target.id, { resolution: undefined });
    return out;
  },
});

function policyAction({ policy, projectDir, agent, id }) {
  return {
    action: "task.reopen",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      if (!policy) return { decision: "abstain" };
      const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
      return authorizeAction({
        policy,
        action: "task.reopen",
        actor: agent,
        target: {
          ...target,
          done_by: node && node.done_by ? node.done_by : null,
        },
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
    },
  };
}

export default async function reopen({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
}) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "reopen: node id required", { field: "id" });
  const reason = readReason(flags, positional);
  const agent = resolveAgent(flags, "reopen");
  const dir = projectDir || statePath;
  const policy = await loadApplicablePolicy({ projectDir: dir });

  const mutation = await mutate({
    projectDir: dir,
    request: {
      action: "reopen",
      actor: agent,
      input: { id, reason, actor: agent },
    },
    provider: {
      async prepare(args) {
        return providerFor(args.snapshot, id).prepare(args);
      },
      async apply(args) {
        return (args.plan.target.subkind === "gate"
          ? gateReopenAdapterProvider
          : taskReopenAdapterProvider).apply(args);
      },
    },
    policyAction: policyAction({ policy, projectDir: dir, agent, id }),
    pluginId,
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `reopen: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}
