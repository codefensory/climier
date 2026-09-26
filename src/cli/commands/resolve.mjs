// `resolve <id>` CLI adapter for gate.resolve.
// Application Operations selects the gate provider; the kernel remains the
// sole mutation frontier for locking, revisions, policy and audit persistence.
import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { gateResolveProvider } from "../../providers/gate/lifecycle.mjs";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.mjs";

const REGISTRY = bootstrapBuiltins();

export const knownFlags = ["as", "note", "choice", "rationale"];

function gateSnapshot(snapshot, id) {
  // add-node historically omitted resolution_mode while the CLI still
  // treated such gates as choice gates. Keep that legacy default at the CLI
  // boundary; typed operation callers remain strict.
  const node = snapshot.nodes[id];
  if (!node || (node.resolution_mode && node.status !== "resolved")) {
    return snapshot;
  }
  return {
    ...snapshot,
    nodes: {
      ...snapshot.nodes,
      [id]: {
        ...node,
        resolution_mode: node.resolution_mode || "choice",
        // The historical CLI did not reject a repeated resolve.
        ...(node.status === "resolved" ? { status: "open" } : {}),
      },
    },
  };
}

function validateGateTarget(node, id) {
  if (node && (node.kind !== "resolvable" || node.subkind !== "gate")) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `resolve: node ${id} is not a gate (kind=${node.kind}, subkind=${node.subkind || "undefined"})`,
      { id, kind: node.kind, subkind: node.subkind || null },
    );
  }
}

function preserveResolveStatus(prepared, status) {
  if (status === undefined) {
    return prepared;
  }
  return { ...prepared, target: { ...prepared.target, status } };
}

async function prepareCliResolve(args, id, resolvedNode) {
  const node = args.snapshot.nodes[id];
  resolvedNode.value = node || null;
  validateGateTarget(node, id);
  const prepared = await gateResolveProvider.prepare({
    ...args, snapshot: gateSnapshot(args.snapshot, id),
  });
  return preserveResolveStatus(prepared, args.snapshot.nodes[id]?.status);
}

function sourceWithCliProvider(source, id, resolvedNode) {
  return {
    ...source,
    registry: {
      lookup(operation) {
        const entry = source.registry.lookup(operation);
        if (operation !== "gate.resolve" || !entry) {
          return entry;
        }
        return {
          ...entry,
          provider: {
            prepare: (args) => prepareCliResolve(args, id, resolvedNode),
            apply: gateResolveProvider.apply,
          },
        };
      },
    },
  };
}

function resolveRemoteNode(mutation, id) {
  const node = nodeFromMutation(mutation, id) || mutation.result?.node || null;
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `resolve: remote operation did not return node ${id}`, { id });
  }
  return { node, newly_ready: mutation.effects?.newly_ready || [] };
}

async function resolveRemotely({ backendClient, agent, id, input }) {
  if (backendClient?.type !== "remote") {
    return null;
  }
  const mutation = await executeRemoteDomain({ backendClient, actor: agent, operation: "gate.resolve", input, command: "resolve" });
  return resolveRemoteNode(mutation, id);
}

function createResolveSource(suppliedSource, policy, pluginId) {
  return suppliedSource || {
    registry: REGISTRY, mutate, selectPolicy: async () => policy, authorizeAction, pluginId,
  };
}

function cliResolveSource({ suppliedSource, policy, pluginId, id, resolvedNode }) {
  return sourceWithCliProvider(createResolveSource(suppliedSource, policy, pluginId), id, resolvedNode);
}

async function resolveLocally({ dir, agent, id, input, pluginId, suppliedSource }) {
  const policy = suppliedSource ? null : await loadApplicablePolicy({ projectDir: dir });
  const resolvedNode = { value: null };
  const source = cliResolveSource({ suppliedSource, policy, pluginId, id, resolvedNode });
  const mutation = await executeOperation({
    projectDir: dir, actor: agent, operation: "gate.resolve", input, source, policyActionFromPlan: true,
  });
  return projectLocalResolve(mutation, id, resolvedNode);
}

function projectLocalResolve(mutation, id, resolvedNode) {
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  const node = updated?.node || (resolvedNode.value?.status === "resolved" ? resolvedNode.value : null);
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `resolve: kernel did not return node ${id}`, { id });
  }
  return {
    node,
    newly_ready: mutation.effects && Array.isArray(mutation.effects.newly_ready) ? mutation.effects.newly_ready : [],
  };
}

export default async function resolve({
  statePath, projectDir, flags = {}, positional = [], pluginId, backendClient, source: suppliedSource,
}) {
  const id = positional[0];
  if (!id) {
    throwV2("MISSING_FIELD", "resolve: node id required", { field: "id" });
  }
  const agent = resolveAgent(flags, "resolve");
  const dir = projectDir || statePath;
  const input = { id, note: flags.note, choice: flags.choice, rationale: flags.rationale, actor: agent };
  const remote = await resolveRemotely({ backendClient, agent, id, input });
  if (remote) {
    return remote;
  }
  return resolveLocally({ dir, agent, id, input, pluginId, suppliedSource });
}
