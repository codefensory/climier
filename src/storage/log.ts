import { emptyState, sqliteStateFile } from "./state.ts";
import { withMutationBoundary } from "./lock.ts";
import { readState } from "./state.ts";
import { writeSqliteState } from "./sqlite/store.ts";

function resolvedPluginId(ctx) {
  const pluginId = ctx && typeof ctx.pluginId === "string" ? ctx.pluginId.trim() : "";
  return pluginId || null;
}

export function prepareLogEntry(entry, ctx = {}) {
  if (!entry || typeof entry !== "object") { throw new Error("prepareLogEntry: entry must be an object"); }
  if (!entry.action) { throw new Error("prepareLogEntry: entry.action is required"); }
  if (!entry.agent) { throw new Error("prepareLogEntry: entry.agent is required"); }
  const out = { ts: new Date().toISOString(), ...entry };
  const pluginId = resolvedPluginId(ctx);
  if (pluginId) { out.plugin_id = pluginId; }
  return out;
}

function validateAppendEntry(entry) {
  if (!entry || typeof entry !== "object") { throw new Error("append: entry must be an object"); }
  if (!entry.action) { throw new Error("append: entry.action is required"); }
  if (!entry.agent) { throw new Error("append: entry.agent is required"); }
}

export async function append(projectDir, entry) {
  validateAppendEntry(entry);
  const preparedEntry = prepareLogEntry(entry);
  return withMutationBoundary(projectDir, async () => {
    const state = await readState(projectDir) || emptyState();
    const next = {
      ...state,
      revision: state.revision + 1,
      log: [...(Array.isArray(state.log) ? state.log : []), preparedEntry],
    };
    return writeSqliteState(sqliteStateFile(projectDir), next);
  });
}

export async function appendWithContext(projectDir, entry, ctx = {}) {
  validateAppendEntry(entry);
  return append(projectDir, prepareLogEntry(entry, ctx));
}
