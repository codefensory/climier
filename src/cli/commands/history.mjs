// `history <id>`: log entries that reference a node id.
//
// Be generous — an entry counts if `node === id` OR `task === id` OR
// `node === id` OR the string `id` appears in `note`
// (covers things like `add-edge A B` whose note string mentions B).
// Every mutation records its target under the canonical `node` field, so that
// entries remain searchable without migration.
//
// Returns { id, entries }; entries is [] when nothing matches.

import { readState } from "../../storage/state.mjs";

export const knownFlags = ["limit"];

const REFERENCE_FIELDS = ["node"];

function entryReferencesId(entry, id) {
  if (!entry || !id) {return false;}
  if (REFERENCE_FIELDS.some((field) => entry[field] === id)) {return true;}
  // add-edge / add-node style: the note is `${from} ${type} ${to}` (add-edge)
  // or the node id itself (add-node). The split includes the id when present.
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
