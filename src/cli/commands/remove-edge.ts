
import { executeOperation } from "../../application/operations/index.ts";
import { getOperationSource } from "../../operation-source.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";
import type { CliMutation, CommandContext } from "./contracts.ts";
import { executeRemoteDomain } from "./internal/domain-routing.ts";

export const knownFlags = ["type", "as"];

async function removeEdgeRemotely({ backendClient, actor, input }) {
  if (backendClient?.type !== "remote") {
    return null;
  }
  const mutation = await executeRemoteDomain({ backendClient, actor, operation: "edge.remove", input, command: "remove-edge" }) as CliMutation;
  return { result: mutation.result };
}

async function removeEdgeLocally({ projectDir, actor, input, suppliedSource }) {
  const source = suppliedSource || await getOperationSource();
  const outcome = await executeOperation({ projectDir, actor, operation: "edge.remove", input, source }) as CliMutation;
  return outcome.result;
}

export default async function removeEdge({ statePath, projectDir: suppliedProjectDir, positional, flags, backendClient, source: suppliedSource }: CommandContext) {
  const [from, to] = positional;
  if (!from || !to) {
    throwV2("MISSING_FIELD", "remove-edge: from and to ids required", { field: "from,to" });
  }
  if (!flags.type) {
    throwV2("MISSING_FIELD", "remove-edge: --type required", { field: "type" });
  }

  const actor = resolveAgent(flags, "remove-edge");
  const projectDir = suppliedProjectDir || statePath;
  const input: Record<string, unknown> = { from, to, type: flags.type };
  const remote = await removeEdgeRemotely({ backendClient, actor, input });
  if (remote !== null) {
    return remote.result;
  }
  return removeEdgeLocally({ projectDir, actor, input, suppliedSource });
}
