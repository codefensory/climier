// Canonical log entry shape. Persisting an entry is the kernel's job: this
// module only shapes and validates entries, so a log write cannot happen
// outside the mutation transaction.

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
