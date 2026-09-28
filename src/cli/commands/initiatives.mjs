
import { readState } from "../../storage/state.mjs";
import { projectInitiativesView } from "../../read-model/index.mjs";

export const knownFlags = ["all"];

export default async function initiatives({ statePath, flags, backendClient }) {
  if (backendClient?.type === "remote") {
    return backendClient.readInitiatives({ all: flags.all === true || flags.all === "true" });
  }

  const projectDir = statePath;
  const s = await readState(projectDir);
  if (!s) {
    return { initiatives: [], unregistered: { nodes: 0, values: [] } };
  }

  return projectInitiativesView({
    snapshot: s,
    all: flags.all === true || flags.all === "true",
  });
}
