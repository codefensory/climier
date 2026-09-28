// log: read and filter the append-only log.
import { projectLogView } from "../../read-model/index.mjs";
import { readState } from "../../storage/state.mjs";

export const knownFlags = ["limit", "action", "agent", "node"];

async function readRemoteLog(flags, backendClient) {
  const limit = flags.limit ? Number.parseInt(flags.limit, 10) : undefined;
  return backendClient.readLog({
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    action: flags.action || undefined,
    agent: flags.agent || undefined,
    node: flags.node || undefined,
  });
}

async function readLocalLog(statePath, flags) {
  const snapshot = await readState(statePath);
  if (!snapshot) {return [];}
  return projectLogView({ snapshot, filters: flags });
}

export default async function log({ statePath, flags, backendClient }) {
  if (backendClient?.type === "remote") {return readRemoteLog(flags, backendClient);}
  return readLocalLog(statePath, flags);
}
