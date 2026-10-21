import { sqliteStateExists, stateFile } from "../../storage/state.ts";
import { readSqliteSearchCandidates } from "../../storage/sqlite/store.ts";
import { projectSearchView } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = ["all"];

async function readLocalSearch(statePath, query, flags) {
  if (!query) {return { matches: [], count: 0 };}
  const all = flags.all === true || flags.all === "true";
  const nodes = await readSqliteSearchCandidates(stateFile(statePath), query, all);
  if (!nodes) {
    await sqliteStateExists(statePath);
    throw new Error("search: state file missing");
  }
  return projectSearchView({ snapshot: { nodes: nodes as import("../../read-model/types.ts").ReadModelSnapshot["nodes"] }, query, all });
}

export default async function search({ statePath, positional, flags, backendClient }: CommandContext) {
  const query = String(positional[0] ?? "").toLowerCase();
  if (backendClient?.type === "remote") {
    return backendClient.readSearch({ query, all: flags.all === true || flags.all === "true" });
  }
  return readLocalSearch(statePath, query, flags);
}
