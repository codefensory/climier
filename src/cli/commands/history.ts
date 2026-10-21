
import { readState } from "../../storage/state.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelSnapshot } from "../../read-model/types.ts";
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
  const snapshot = await readState(statePath) as ReadModelSnapshot | null;
  if (!snapshot) {return { id, entries: [] };}
  return { id, entries: applyLimit(logEntriesForNode(snapshot, id), limit) };
}

export default async function history({ statePath, flags, positional, backendClient }: CommandContext) {
  const [id] = positional;
  if (!id) {
    throw new Error("history: node id required (e.g. history T1)");
  }
  const limit = parseLimit(flags.limit);
  return readHistory({ statePath, id, limit, backendClient });
}
