
import { readState } from "../../storage/state.ts";

export const knownFlags = ["limit"];

export const REFERENCE_FIELDS = ["node"];

function entryReferencesId(entry, id) {
  if (!entry || !id) {return false;}
  if (REFERENCE_FIELDS.some((field) => entry[field] === id)) {return true;}

  return typeof entry.note === "string" && entry.note.split(/\s+/).includes(id);
}

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
  const snapshot = await readState(statePath);
  if (!snapshot) {return { id, entries: [] };}
  return { id, entries: applyLimit(snapshot.log.filter((entry) => entryReferencesId(entry, id)), limit) };
}

export default async function history({ statePath, flags, positional, backendClient }) {
  const [id] = positional;
  if (!id) {
    throw new Error("history: node id required (e.g. history T1)");
  }
  const limit = parseLimit(flags.limit);
  return readHistory({ statePath, id, limit, backendClient });
}
