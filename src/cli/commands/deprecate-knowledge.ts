
import { executeOperation } from "../../application/operations/index.ts";
import { mutate } from "../../kernel/mutate.ts";
import { getOperationSource } from "../../operation-source.ts";

void mutate;
import { asCaughtError, throwV2 } from "../../contracts/errors.ts";
import type { CliMutation } from "./contracts.ts";
import { resolveAgent } from "../actor.ts";
import { deprecateProvider } from "../../providers/knowledge/deprecate.ts";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.ts";

export const knownFlags = ["reason", "as"];

const knowledgeProvider = deprecateProvider();

// Keep the historical CLI error code for a non-knowledge target while leaving

// revision/CAS errors, must propagate unchanged.
const cliKnowledgeProvider = Object.freeze({
  async prepare(args) {
    try {
      const plan = await knowledgeProvider.prepare(args);
      args.request.action = "deprecate-knowledge";
      const node = args.snapshot.nodes[args.input.id];
      return {
        ...plan,
        logAction: "deprecate-knowledge",

        // target projection while retaining the provider's CAS revision.
        target: {
          ...plan.target,
          subkind: node.subkind,
          status: node.status,
        },

        logFields: { reason: plan.reason },
      };
    } catch (caught) {
      const error = asCaughtError(caught);
      if (
        error.code === "INVALID_PROVIDER_INPUT" &&
        error.details &&
        error.details.id === args.input.id &&
        /not a knowledge node/.test(error.message)
      ) {
        throwV2(
          "INVALID_EDGE_KIND",
          `deprecate-knowledge: ${args.input.id} is not a knowledge node (got kind=${error.details.kind})`,
          { id: args.input.id, kind: error.details.kind },
        );
      }
      throw error;
    }
  },
  apply: knowledgeProvider.apply,
});

function withCliProvider(source) {
  const operationSource = typeof source.mutate === "function" ? source : { ...source, mutate: (args) => mutate(args) };
  return {
    ...operationSource,
    registry: {
      ...source.registry,
      lookup(id) {
        const found = source.registry.lookup(id);
        return id === "knowledge.deprecate" && found ? { ...found, provider: cliKnowledgeProvider } : found;
      },
    },
  };
}

function validateDeprecationRequest(positional, flags) {
  const [id] = positional;
  if (!id) {throwV2("MISSING_FIELD", "deprecate-knowledge: node id required", { field: "id" });}
  const reason = flags.reason;
  if (reason === true || !reason || !String(reason).trim()) {
    throwV2("MISSING_FIELD", "deprecate-knowledge: --reason is required", { field: "reason" });
  }
  return { id, input: { id, reason: String(reason) } };
}

async function deprecateRemote(backendClient, agent, id, input) {
  const mutation = await executeRemoteDomain({ backendClient, actor: agent, operation: "knowledge.deprecate", input, command: "deprecate-knowledge" }) as CliMutation;
  return { node: nodeFromMutation(mutation, id) || mutation.result?.node || null };
}

function deprecatedNode(mutation, id) {
  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `deprecate-knowledge: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}

export default async function deprecateKnowledge({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
  backendClient,
  source,
}) {
  const { id, input } = validateDeprecationRequest(positional, flags);
  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "deprecate-knowledge");
  if (backendClient?.type === "remote") {return deprecateRemote(backendClient, agent, id, input);}
  const operationSource = source || await getOperationSource();
  const mutation = await executeOperation({
    projectDir: dir,
    actor: agent,
    operation: "knowledge.deprecate",
    input,
    source: withCliProvider({ ...operationSource, ...(pluginId ? { pluginId } : {}) }),
  });
  return deprecatedNode(mutation, id);
}
