import { assertStateVersion, isFencedState, readState } from "../../storage/state.mjs";
import { projectSearchView } from "../../read-model/index.mjs";

export const knownFlags = ["all"];

export default async function search({ statePath, positional, flags, backendClient }) {
  const query = String(positional[0] ?? "").toLowerCase();
  if (backendClient?.type === "remote") {
    return backendClient.readSearch({ query, all: flags.all === true || flags.all === "true" });
  }
  if (!query) return { matches: [], count: 0 };

  const state = await readState(statePath);
  if (!state) throw new Error("search: state file missing");
  assertStateVersion(state, isFencedState(state) ? 5 : 2, "search");
  const all = flags.all === true || flags.all === "true";
  return projectSearchView({ snapshot: state, query, all });
}
