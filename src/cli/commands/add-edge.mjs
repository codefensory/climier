
// atomic state + log write. The adapter delegates the operation to

import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { executeRemoteDomain } from "./internal/domain-routing.mjs";

const REGISTRY = bootstrapBuiltins();

function withCliProvider(source) {
  return {
    ...source,
    registry: {
      ...source.registry,
      lookup(id) {
        const entry = source.registry.lookup(id);
        if (id !== POLICY_ACTION || !entry) {return entry;}
        return {
          ...entry,
          provider: {
            ...entry.provider,
            async prepare(args) {
              const plan = await entry.provider.prepare(args);
              args.request.action = LOG_ACTION;
              return { ...plan, logAction: LOG_ACTION };
            },
          },
        };
      },
    },
  };
}

export const knownFlags = ["type", "as"];

const POLICY_ACTION = "edge.add";
const LOG_ACTION = "add-edge";

function edgePolicyAction(policy, projectDir) {
  if (!policy) {return undefined;}
  return {
    action: POLICY_ACTION,
    pluginId: policy.pluginId || null,
    decide: async ({ snapshot, target, request, action }) => authorizeAction({
      policy,
      action,
      actor: request.actor,
      target,
      snapshot,
      projectDir,
      projectConfig: policy.projectConfig || {},
    }),
  };
}

function edgeSource(source, policy, projectDir, pluginId) {
  return withCliProvider(source || {
    registry: REGISTRY,
    mutate,
    selectPolicy: async () => policy,
    policyAction: edgePolicyAction(policy, projectDir),
    authorizeAction,
    pluginId,
  });
}

async function addRemoteEdge(backendClient, agent, input) {
  const mutation = await executeRemoteDomain({ backendClient, actor: agent, operation: "edge.add", input, command: "add-edge" });
  return mutation.result;
}

function validateEdgeArgs(positional, flags) {
  const [from, to] = positional;
  if (!from || !to) {
    throwV2("MISSING_FIELD", "add-edge: from and to ids required", { field: "from,to" });
  }
  if (!flags.type) {
    throwV2("MISSING_FIELD", "add-edge: --type required", { field: "type" });
  }
  return { from, to, type: flags.type };
}

async function addLocalEdge({ projectDir, agent, input, source, pluginId }) {
  const policy = await loadApplicablePolicy({ projectDir });
  const result = await executeOperation({
    projectDir,
    actor: agent,
    operation: POLICY_ACTION,
    input,
    source: edgeSource(source, policy, projectDir, pluginId),
  });
  const edge = result.result && result.result.edge ? result.result.edge : null;
  return { edge };
}

export default async function addEdge({ statePath, projectDir: suppliedProjectDir, positional = [], flags = {}, pluginId, backendClient, source }) {
  const input = validateEdgeArgs(positional, flags);
  const projectDir = suppliedProjectDir || statePath;
  const agent = resolveAgent(flags, "add-edge");
  if (backendClient?.type === "remote") {return addRemoteEdge(backendClient, agent, input);}
  return addLocalEdge({ projectDir, agent, input, source, pluginId });
}
