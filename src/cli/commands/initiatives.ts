
import { readState } from "../../storage/state.ts";
import { projectInitiativesView } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";
import type { ReadModelSnapshot } from "../../read-model/types.ts";

export const knownFlags = ["all"];

export default async function initiatives({ statePath, flags, backendClient }: CommandContext) {
  if (backendClient?.type === "remote") {
    return backendClient.readInitiatives({ all: flags.all === true || flags.all === "true" });
  }

  const projectDir = statePath;
  const s = await readState(projectDir) as ReadModelSnapshot | null;
  if (!s) {
    return { initiatives: [], unregistered: { nodes: 0, values: [] } };
  }

  return projectInitiativesView({
    snapshot: s,
    all: flags.all === true || flags.all === "true",
  });
}
