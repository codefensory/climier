// `resolve <id>` CLI adapter for task.resolve / gate.resolve.
// The kernel owns locking, state, revisions and logs; this module only maps
// CLI flags to the typed provider request and projects the legacy envelope.
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { taskResolveProvider } from "../../providers/task/resolve.mjs";
import { prepareGateResolve, applyGateResolve } from "../../providers/gate/lifecycle.mjs";

export const knownFlags = ["as", "note", "choice", "rationale"];

function providerFor(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  if (node && node.subkind === "gate") return gateResolveAdapterProvider;
  return taskResolveAdapterProvider;
}

function gateSnapshot(snapshot, id) {
  // add-node historically omitted resolution_mode while the CLI still
  // treated such gates as choice gates. Keep that legacy default at the
  // adapter boundary; the gate provider remains strict for typed callers.
  const node = snapshot.nodes[id];
  if (node && node.resolution_mode && node.status !== "resolved") return snapshot;
  return {
    ...snapshot,
    nodes: {
      ...snapshot.nodes,
      [id]: {
        ...node,
        resolution_mode: node && node.resolution_mode ? node.resolution_mode : "choice",
        // The historical CLI handler did not reject a repeated resolve. Let
        // the typed provider validate the shape while retaining that legacy
        // behavior at this compatibility boundary.
        ...(node && node.status === "resolved" ? { status: "open" } : {}),
      },
    },
  };
}

function taskSnapshot(snapshot, id) {
  const node = snapshot.nodes[id];
  if (!node || node.status !== "done") return snapshot;
  // The historical CLI handler accepted a repeated task resolve (the lock
  // still serialized both writes). The typed provider deliberately rejects a
  // done task, so adapt only this legacy surface without weakening the typed
  // provider/API contract.
  return {
    ...snapshot,
    nodes: { ...snapshot.nodes, [id]: { ...node, status: "open" } },
  };
}

const taskResolveAdapterProvider = Object.freeze({
  async prepare(args) {
    const node = args.snapshot.nodes[args.input.id];
    // Preserve the CLI's historical error classification while delegating all
    // valid task lifecycle semantics to the typed provider.
    if (node && node.kind !== "resolvable") {
      throwV2(
        "INVALID_STATUS",
        `resolve: node ${args.input.id} is not resolvable (kind=${node.kind})`,
        { id: args.input.id, kind: node.kind },
      );
    }
    if (node && node.subkind !== "task") {
      throwV2(
        "INVALID_STATUS",
        `resolve: node ${args.input.id} is not a task or gate (subkind=${node.subkind || "undefined"})`,
        { id: args.input.id, subkind: node.subkind || null },
      );
    }
    const plan = await taskResolveProvider.prepare({
      ...args,
      snapshot: taskSnapshot(args.snapshot, args.input.id),
    });
    return {
      ...plan,
      logFields: { note: plan.note },
      target: {
        ...plan.target,
        status: args.snapshot.nodes[args.input.id]?.status || plan.target.status,
        claim: args.snapshot.nodes[args.input.id]?.claim || null,
        done_by: args.snapshot.nodes[args.input.id]?.done_by || null,
      },
    };
  },
  apply: taskResolveProvider.apply,
});

const gateResolveAdapterProvider = Object.freeze({
  async prepare(args) {
    const prepared = await prepareGateResolve({ ...args, snapshot: gateSnapshot(args.snapshot, args.input.id) });
    const status = args.snapshot.nodes[args.input.id]?.status;
    return status === undefined ? prepared : { ...prepared, target: { ...prepared.target, status } };
  },
  apply: applyGateResolve,
});

function policyAction({ policy, projectDir, agent, id }) {
  return {
    action: "task.resolve",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      if (!policy) return { decision: "abstain" };
      const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
      return authorizeAction({
        policy,
        action: "task.resolve",
        actor: agent,
        target: {
          ...target,
          claim: node && node.claim ? { ...node.claim } : null,
          done_by: node && node.done_by ? node.done_by : null,
        },
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
    },
  };
}

export default async function resolve({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
}) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "resolve: node id required", { field: "id" });
  const agent = resolveAgent(flags, "resolve");
  const dir = projectDir || statePath;
  const policy = await loadApplicablePolicy({ projectDir: dir });

  const input = {
    id,
    note: flags.note,
    choice: flags.choice,
    rationale: flags.rationale,
    actor: agent,
  };

  const mutation = await mutate({
    projectDir: dir,
    request: { action: "resolve", actor: agent, input },
    provider: {
      async prepare(args) {
        const provider = providerFor(args.snapshot, id);
        // Select the provider from the fresh snapshot and let its typed
        // validation enforce the required fields for that node kind.
        return provider.prepare(args);
      },
      async apply(args) {
        const provider = args.plan.target.subkind === "gate"
          ? gateResolveAdapterProvider
          : taskResolveAdapterProvider;
        return provider.apply(args);
      },
    },
    policyAction: policyAction({ policy, projectDir: dir, agent, id }),
    pluginId,
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `resolve: kernel did not return node ${id}`, { id });
  }
  return {
    node: updated.node,
    newly_ready: mutation.effects && Array.isArray(mutation.effects.newly_ready)
      ? mutation.effects.newly_ready
      : [],
  };
}
