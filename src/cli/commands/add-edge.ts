
// atomic state + log write. The adapter delegates the operation to

import { executeOperation } from "../../application/operations/index.ts";
import { getOperationSource } from "../../operation-source.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";
import { executeRemoteDomain } from "./internal/domain-routing.ts";

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

async function edgeSource(source, pluginId) {
  const operationSource = source || await getOperationSource();
  return withCliProvider({ ...operationSource, ...(pluginId ? { pluginId } : {}) });
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
  const result = await executeOperation({
    projectDir,
    actor: agent,
    operation: POLICY_ACTION,
    input,
    source: await edgeSource(source, pluginId),
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
