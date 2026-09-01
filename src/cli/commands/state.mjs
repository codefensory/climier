// state — read the current serialized project state as the public core
// projection. This is intentionally separate from `snapshots`, which lists
// historical recovery points.
//
// The state is read once and passed to the canonical read-model projection so
// revision, nodes, edges, and derived lifecycle statuses all describe the
// same current state. A CLI caller has no plugin namespace, so plugin data is
// omitted rather than exposing any plugin's private namespace.
import { readState } from "../../storage/state.mjs";
import { projectSnapshot } from "../../read-model/index.mjs";

export const knownFlags = [];

export default async function state({ statePath }) {
  const snapshot = await readState(statePath);
  return projectSnapshot({ snapshot });
}
