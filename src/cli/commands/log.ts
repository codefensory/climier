
import { projectLogView } from "../../read-model/index.ts";
import { sqliteStateExists, stateFile } from "../../storage/state.ts";
import { readSqliteLogEntries } from "../../storage/sqlite/store.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelLogEntry } from "../../read-model/types.ts";

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
  const entries = await readSqliteLogEntries(stateFile(statePath), {
    action: flags.action as string | undefined,
    agent: flags.agent as string | undefined,
    node: flags.node as string | undefined,
  }) as ReadModelLogEntry[] | null;
  if (!entries) {
    await sqliteStateExists(statePath);
    return [];
  }
  return projectLogView({ snapshot: { log: entries }, filters: flags });
}

export default async function log({ statePath, flags, backendClient }: CommandContext) {
  if (backendClient?.type === "remote") {return readRemoteLog(flags, backendClient);}
  return readLocalLog(statePath, flags);
}
