
import { executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { getOperationSource } from "../../operation-source.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { gateResolveProvider } from "../../providers/gate/lifecycle.mjs";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.mjs";

export const knownFlags = ["as", "note", "choice", "rationale"];

function validateGateTarget(node, id) {
  if (node && (node.kind !== "resolvable" || node.subkind !== "gate")) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `resolve: node ${id} is not a gate (kind=${node.kind}, subkind=${node.subkind || "undefined"})`,
      { id, kind: node.kind, subkind: node.subkind || null },
    );
  }
}

async function prepareCliResolve(args, id, resolvedNode, provider) {
  const node = args.snapshot.nodes[id];
  resolvedNode.value = node || null;
  validateGateTarget(node, id);
  return provider.prepare(args);
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
        const provider = entry.provider || entry;
        return {
          ...entry,
          provider: {
            prepare: (args) => prepareCliResolve(args, id, resolvedNode, provider),
            apply: provider.apply,
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

async function createResolveSource(suppliedSource, pluginId) {
  const selectedSource = suppliedSource || await getOperationSource();
  const operationSource = typeof selectedSource.mutate === "function" ? selectedSource : { ...selectedSource, mutate };
  return { ...operationSource, ...(pluginId ? { pluginId } : {}) };
}

function cliResolveSource({ operationSource, id, resolvedNode }) {
  return sourceWithCliProvider(operationSource, id, resolvedNode);
}

async function resolveLocally({ dir, agent, id, input, pluginId, suppliedSource }) {
  const resolvedNode = { value: null };
  const operationSource = await createResolveSource(suppliedSource, pluginId);
  const source = cliResolveSource({ operationSource, id, resolvedNode });
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
