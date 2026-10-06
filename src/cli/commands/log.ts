
import { projectLogView } from "../../read-model/index.ts";
import { readState } from "../../storage/state.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelSnapshot } from "../../read-model/types.ts";

export const knownFlags = ["limit", "action", "agent", "node"];

async function readRemoteLog(flags, backendClient) {
  const limit = typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : undefined;
  return backendClient.readLog({
    limit: limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : undefined,
    action: flags.action || undefined,
    agent: flags.agent || undefined,
    node: flags.node || undefined,
  });
}

async function readLocalLog(statePath, flags) {
  const snapshot = await readState(statePath) as ReadModelSnapshot | null;
  if (!snapshot) {return [];}
  return projectLogView({ snapshot, filters: flags });
}

export default async function log({ statePath, flags, backendClient }: CommandContext) {
  if (backendClient?.type === "remote") {return readRemoteLog(flags, backendClient);}
  return readLocalLog(statePath, flags);
}
