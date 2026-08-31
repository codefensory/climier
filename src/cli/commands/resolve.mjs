// `resolve <id>` CLI adapter for gate.resolve.
// The kernel owns locking, state, revisions and logs; this module only maps
// CLI flags to the typed gate provider and projects the command envelope.
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { prepareGateResolve, applyGateResolve } from "../../providers/gate/lifecycle.mjs";

export const knownFlags = ["as", "note", "choice", "rationale"];

function gateSnapshot(snapshot, id) {
  // add-node historically omitted resolution_mode while the CLI still
  // treated such gates as choice gates. Keep that legacy default at the
  // adapter boundary; the gate provider remains strict for typed callers.
  const node = snapshot.nodes[id];
  if (!node || (node.resolution_mode && node.status !== "resolved")) return snapshot;
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

const gateResolveAdapterProvider = Object.freeze({
  async prepare(args) {
    const node = args.snapshot.nodes[args.input.id];
    if (node && (node.kind !== "resolvable" || node.subkind !== "gate")) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `resolve: node ${args.input.id} is not a gate (kind=${node.kind}, subkind=${node.subkind || "undefined"})`,
        { id: args.input.id, kind: node.kind, subkind: node.subkind || null },
      );
    }
    const prepared = await prepareGateResolve({ ...args, snapshot: gateSnapshot(args.snapshot, args.input.id) });
    const status = args.snapshot.nodes[args.input.id]?.status;
    return status === undefined ? prepared : { ...prepared, target: { ...prepared.target, status } };
  },
  apply: applyGateResolve,
});

function policyAction({ policy, projectDir, agent }) {
  return {
    action: "gate.resolve",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      if (!policy) return { decision: "abstain" };
      return authorizeAction({
        policy,
        action: "gate.resolve",
        actor: agent,
        target,
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
      prepare: gateResolveAdapterProvider.prepare,
      apply: gateResolveAdapterProvider.apply,
    },
    policyAction: policyAction({ policy, projectDir: dir, agent }),
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
