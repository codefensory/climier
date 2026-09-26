// initiatives: list registered initiatives with usage counts.
// Counts both resolvable and knowledge nodes per initiative.
// --all includes initiatives with zero live nodes (default hides them, per the
// v2 design doc: "Por defecto muestra solo initiatives con nodos vivos").
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
