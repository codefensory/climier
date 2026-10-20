
import { readState } from "../../storage/state.ts";
import { projectSnapshot } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = [];

async function exportState(statePath: string, backendClient: CommandContext["backendClient"]) {
  if (backendClient?.type === "remote") { throw new Error("state export: only local storage backends can export schema-1 state"); }
  return readState(statePath);
}

export default async function state({ statePath, backendClient, positional = [] }: CommandContext) {
  const subcommand = positional[0];
  if (subcommand === "export") { return exportState(statePath, backendClient); }
  if (subcommand) { throw new Error(`state: unknown subcommand '${subcommand}' (expected export)`); }
  if (backendClient?.type === "remote") {return backendClient.readState();}
  const snapshot = await readState(statePath) as import("../../read-model/types.ts").ReadModelSnapshot | null;
  return projectSnapshot({ snapshot: snapshot || undefined });
}
