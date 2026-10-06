import { assertReadableState, readState } from "../../storage/state.ts";
import { projectSearchView } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = ["all"];

async function readLocalSearch(statePath, query, flags) {
  if (!query) {return { matches: [], count: 0 };}
  const snapshot = await readState(statePath) as import("../../read-model/types.ts").ReadModelSnapshot | null;
  if (!snapshot) {throw new Error("search: state file missing");}
  assertReadableState(snapshot, "search");
  const all = flags.all === true || flags.all === "true";
  return projectSearchView({ snapshot, query, all });
}

export default async function search({ statePath, positional, flags, backendClient }: CommandContext) {
  const query = String(positional[0] ?? "").toLowerCase();
  if (backendClient?.type === "remote") {
    return backendClient.readSearch({ query, all: flags.all === true || flags.all === "true" });
  }
  return readLocalSearch(statePath, query, flags);
}
