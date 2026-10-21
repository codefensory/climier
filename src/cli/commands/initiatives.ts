
import { sqliteStateExists, stateFile } from "../../storage/state.ts";
import { readSqliteInitiatives, readSqliteNodeMetadata, withSqliteReadTransaction } from "../../storage/sqlite/store.ts";
import { projectInitiativesView } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelNode, ReadModelSnapshot } from "../../read-model/types.ts";

export const knownFlags = ["all"];

export default async function initiatives({ statePath, flags, backendClient }: CommandContext) {
  if (backendClient?.type === "remote") {
    return backendClient.readInitiatives({ all: flags.all === true || flags.all === "true" });
  }

  const file = stateFile(statePath);
  const result = await withSqliteReadTransaction(file, async () => {
    const [registry, nodes] = await Promise.all([
      readSqliteInitiatives(file),
      readSqliteNodeMetadata(file, { fields: ["id", "kind", "initiative"] }),
    ]);
    if (!registry || !nodes) {return null;}
    const snapshot: ReadModelSnapshot = {
      initiatives: registry,
      nodes: nodes as Record<string, ReadModelNode>,
    };
    return projectInitiativesView({
      snapshot,
      all: flags.all === true || flags.all === "true",
    });
  });
  if (!result) {
    await sqliteStateExists(statePath);
    return { initiatives: [], unregistered: { nodes: 0, values: [] } };
  }
  return result;
}
