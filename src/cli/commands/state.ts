import { resolveAgent } from "../actor.ts";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.ts";
import { readState } from "../../storage/state.ts";
import { migrateJsonStateToSqlite } from "../../storage/sqlite/migrate.ts";
import { compactState } from "../../kernel/state-operations.ts";
import { DEFAULT_LOG_RETENTION } from "../../storage/sqlite/log-checkpoint.ts";
import { projectSnapshot } from "../../read-model/index.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = ["as", "yes", "keep"];

function assertAllowedFlags(flags: CommandContext["flags"], allowed: string[], command: string) {
  const globalFlags = ["project", "no-warnings"];
  const invalid = Object.keys(flags).find((flag) => flags[flag] !== undefined && !allowed.includes(flag) && !globalFlags.includes(flag));
  if (invalid === "as" || invalid === "yes") { throw new Error("state: --as and --yes are only valid with state migrate"); }
  if (invalid === "keep") { throw new Error("state: --keep is only valid with state compact"); }
  if (invalid) { throw new Error(`${command}: --${invalid} is not valid here`); }
}

async function exportState({ statePath, backendClient, flags = {} }: CommandContext) {
  assertAllowedFlags(flags, [], "state export");
  if (backendClient?.type === "remote") { throw new Error("state export: only local storage backends can export schema-1 state"); }
  return readState(statePath);
}

async function migrateState({ projectDir, statePath, backendClient, flags = {} }: CommandContext) {
  assertAllowedFlags(flags, ["as", "yes"], "state migrate");
  if (backendClient?.type === "remote") { throw new Error("state migrate: only local storage backends can migrate"); }
  resolveAgent(flags, "state migrate");
  if (flags.yes !== true && flags.yes !== "true") {
    throw new Error("state migrate: explicit confirmation required (pass --yes)");
  }
  return migrateJsonStateToSqlite(projectDir || statePath);
}

function parseKeep(value: CommandContext["flags"]["keep"]) {
  if (value === undefined) { return DEFAULT_LOG_RETENTION; }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`state compact: --keep must be a non-negative integer (got '${String(value)}')`);
  }
  return Number(value);
}

function policyForCompact({ policy, projectDir, projectConfig, actor }: { policy: Awaited<ReturnType<typeof loadApplicablePolicy>>; projectDir: string; projectConfig: CommandContext["projectConfig"]; actor: string }) {
  if (!policy) { return null; }
  return {
    action: "state.compact",
    pluginId: policy.pluginId,
    decide: async ({ snapshot, target, action }) => authorizeAction({
      policy,
      action,
      actor,
      snapshot: { state: snapshot.state, nodes: snapshot.nodes, edges: snapshot.edges, initiatives: snapshot.initiatives },
      target,
      projectDir,
      projectConfig: policy.projectConfig || projectConfig || {},
    }),
  };
}

async function compactStateCommand({ projectDir, statePath, backendClient, flags = {}, pluginId, projectConfig = {} }: CommandContext) {
  assertAllowedFlags(flags, ["as", "keep"], "state compact");
  if (backendClient?.type === "remote") { throw new Error("state compact: only local storage backends can compact logs"); }
  const keep = parseKeep(flags.keep);
  const actor = resolveAgent(flags, "state compact");
  const dir = projectDir || statePath;
  const policy = await loadApplicablePolicy({ projectDir: dir });
  const mutation = await compactState({
    projectDir: dir,
    keep,
    actor,
    policyAction: policyForCompact({ policy, projectDir: dir, projectConfig, actor }),
    pluginId,
  }) as { result?: unknown };
  return mutation.result;
}

async function readProjection({ statePath, backendClient, flags = {} }: CommandContext) {
  assertAllowedFlags(flags, [], "state");
  if (backendClient?.type === "remote") { return backendClient.readState(); }
  const snapshot = await readState(statePath) as import("../../read-model/types.ts").ReadModelSnapshot | null;
  return projectSnapshot({ snapshot: snapshot || undefined });
}

const SUBCOMMANDS: Record<string, (context: CommandContext) => Promise<unknown>> = {
  compact: compactStateCommand,
  export: exportState,
  migrate: migrateState,
};

export default async function state(context: CommandContext) {
  const [subcommand, ...args] = context.positional || [];
  if (!subcommand) { return readProjection(context); }
  const handler = SUBCOMMANDS[subcommand];
  if (!handler || args.length > 0) {
    throw new Error("state: invalid subcommand or arguments (expected export, migrate --as <agent> --yes, or compact [--keep N] --as <agent>)");
  }
  return handler(context);
}
