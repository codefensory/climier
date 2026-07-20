// F12 — `history <id>`: log entries that reference a node/task.
//
// For v2, be generous — an entry counts if `node === id` OR `task === id` OR
// `decision === id` OR `gotcha === id` OR the string `id` appears in `note`
// (covers things like `add-edge A B` whose note string mentions B).
// For v1, surface a v1-flavored view under the same {id, entries} envelope:
//
//   { id, entries: [...] }   — entries is [] when nothing matches.
//
// v1 detail view (per-id with task/decision/gotcha) is not provided here;
// use `climier log --task X` for that.

import { readState } from "../state.mjs";
import { isV2State } from "../state.mjs";

export const knownFlags = ["limit"];

function entryReferencesId(entry, id) {
  if (!entry || !id) return false;
  if (entry.node === id) return true;
  if (entry.task === id) return true;
  if (entry.decision === id) return true;
  if (entry.gotcha === id) return true;
  if (typeof entry.note === "string" && entry.note.split(/\s+/).includes(id)) return true;
  // add-edge / add-node style: the note is `${from} ${type} ${to}` (add-edge)
  // or the node id itself (add-node). The split includes the id when present.
  return false;
}

export default async function history({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) {
    throw new Error("history: node id required (e.g. history T1)");
  }
  const limit = flags.limit !== undefined && flags.limit !== true
    ? (() => {
        const n = parseInt(flags.limit, 10);
        if (Number.isNaN(n) || n < 0) {
          throw new Error(`history: --limit must be a non-negative integer (got '${flags.limit}')`);
        }
        return n;
      })()
    : null;

  const s = await readState(statePath);
  if (!s) return { id, entries: [] };
  let entries = (s.log || []).filter((e) => entryReferencesId(e, id));
  if (limit !== null && limit > 0) entries = entries.slice(-limit);
  return { id, entries };
}

// Exported for the bin router: detect v2 and route to a v2-aware histogram
// when needed. (Currently the same implementation handles both versions;
// the keep-both-files split lets future v2-only filters live elsewhere.)
export { isV2State };
