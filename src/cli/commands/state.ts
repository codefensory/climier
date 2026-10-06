
import { readState } from "../../storage/state.ts";
import { projectSnapshot } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = [];

export default async function state({ statePath, backendClient }: CommandContext) {
  if (backendClient?.type === "remote") {return backendClient.readState();}

  const snapshot = await readState(statePath) as import("../../read-model/types.ts").ReadModelSnapshot | null;
  return projectSnapshot({ snapshot: snapshot || undefined });
}
