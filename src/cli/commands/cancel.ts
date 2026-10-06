
import { executeOperation } from "../../application/operations/index.ts";
import { mutate } from "../../kernel/mutate.ts";
import { getOperationSource } from "../../operation-source.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";
import { taskCancelProvider } from "../../providers/task/cancel.ts";
import { executeRemoteResolvableLifecycle } from "./internal/resolvable-lifecycle-routing.ts";
import { prepareGateCancel, applyGateCancel } from "../../providers/gate/lifecycle.ts";

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

function sourceWithCliProvider(source, id) {
  return {
    ...source,
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

async function cancelSource({ suppliedSource, id, pluginId }) {
  const selectedSource = suppliedSource || await getOperationSource();
  const baseSource = typeof selectedSource.mutate === "function" ? selectedSource : { ...selectedSource, mutate };
  return sourceWithCliProvider({ ...baseSource, ...(pluginId ? { pluginId } : {}) }, id);
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
  const mutation = await executeOperation({
    projectDir: dir,
    actor: agent,
    operation: "task.cancel",
    input: { id, reason, actor: agent },
    source: await cancelSource({ suppliedSource, id, pluginId }),
    policyActionFromPlan: true,
  });
  return canceledNode(mutation, id);
}
