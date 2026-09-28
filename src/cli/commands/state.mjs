
import { readState } from "../../storage/state.mjs";
import { projectSnapshot } from "../../read-model/index.mjs";

export const knownFlags = [];

export default async function state({ statePath, backendClient }) {
  if (backendClient?.type === "remote") {return backendClient.readState();}

  const snapshot = await readState(statePath);
  return projectSnapshot({ snapshot });
}
