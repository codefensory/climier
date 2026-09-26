import { assertStateVersion, isFencedState, readState } from "../../storage/state.mjs";
import { projectSearchView } from "../../read-model/index.mjs";

export const knownFlags = ["all"];

async function readLocalSearch(statePath, query, flags) {
  if (!query) {return { matches: [], count: 0 };}
  const snapshot = await readState(statePath);
  if (!snapshot) {throw new Error("search: state file missing");}
  assertStateVersion(snapshot, isFencedState(snapshot) ? 5 : 2, "search");
  const all = flags.all === true || flags.all === "true";
  return projectSearchView({ snapshot, query, all });
}

export default async function search({ statePath, positional, flags, backendClient }) {
  const query = String(positional[0] ?? "").toLowerCase();
  if (backendClient?.type === "remote") {
    return backendClient.readSearch({ query, all: flags.all === true || flags.all === "true" });
  }
  return readLocalSearch(statePath, query, flags);
}
