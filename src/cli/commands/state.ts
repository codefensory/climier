import { resolveAgent } from "../actor.ts";
import { readState } from "../../storage/state.ts";
import { migrateJsonStateToSqlite } from "../../storage/sqlite/migrate.ts";
import { projectSnapshot } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = ["as", "yes"];

function assertMigrationFlags(flags: CommandContext["flags"]) {
  if (flags.as !== undefined || flags.yes !== undefined) {
    throw new Error("state: --as and --yes are only valid with state migrate");
  }
}

async function exportState({ statePath, backendClient, flags = {} }: CommandContext) {
  assertMigrationFlags(flags);
  if (backendClient?.type === "remote") { throw new Error("state export: only local storage backends can export schema-1 state"); }
  return readState(statePath);
}

async function migrateState({ projectDir, statePath, backendClient, flags = {} }: CommandContext) {
  if (backendClient?.type === "remote") { throw new Error("state migrate: only local storage backends can migrate"); }
  resolveAgent(flags, "state migrate");
  if (flags.yes !== true && flags.yes !== "true") {
    throw new Error("state migrate: explicit confirmation required (pass --yes)");
  }
  return migrateJsonStateToSqlite(projectDir || statePath);
}

async function readProjection({ statePath, backendClient, flags = {} }: CommandContext) {
  assertMigrationFlags(flags);
  if (backendClient?.type === "remote") { return backendClient.readState(); }
  const snapshot = await readState(statePath) as import("../../read-model/types.ts").ReadModelSnapshot | null;
  return projectSnapshot({ snapshot: snapshot || undefined });
}

const SUBCOMMANDS: Record<string, (context: CommandContext) => Promise<unknown>> = {
  export: exportState,
  migrate: migrateState,
};

export default async function state(context: CommandContext) {
  const [subcommand, ...args] = context.positional || [];
  if (!subcommand) { return readProjection(context); }
  const handler = SUBCOMMANDS[subcommand];
  if (!handler || args.length > 0) {
    throw new Error("state: invalid subcommand or arguments (expected export or migrate --as <agent> --yes)");
  }
  return handler(context);
}
