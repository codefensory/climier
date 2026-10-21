
import { sqliteStateExists, stateFile } from "../../storage/state.ts";
import { readSqliteLogForNode } from "../../storage/sqlite/store.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelLogEntry } from "../../read-model/types.ts";
import { logEntriesForNode } from "../../read-model/history.ts";

export const knownFlags = ["limit"];
export const REFERENCE_FIELDS = ["node"];

function parseLimit(value) {
  if (value === undefined || value === true) {return null;}
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`history: --limit must be a non-negative integer (got '${value}')`);
  }
  return n;
}

function applyLimit(entries, limit) {
  return limit !== null && limit > 0 ? entries.slice(-limit) : entries;
}

async function readHistory({ statePath, id, limit, backendClient }) {
  if (backendClient?.type === "remote") {
    return backendClient.readHistory({ id, limit: limit === null ? undefined : limit });
  }
  const entries = await readSqliteLogForNode(stateFile(statePath), id) as ReadModelLogEntry[] | null;
  if (!entries) {
    await sqliteStateExists(statePath);
    return { id, entries: [] };
  }
  return { id, entries: applyLimit(logEntriesForNode({ log: entries }, id), limit) };
}

export default async function history({ statePath, flags, positional, backendClient }: CommandContext) {
  const [id] = positional;
  if (!id) {
    throw new Error("history: node id required (e.g. history T1)");
  }
  const limit = parseLimit(flags.limit);
  return readHistory({ statePath, id, limit, backendClient });
}
