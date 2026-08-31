// log.mjs: append entries to the global state log.
//
// Two entry points:
//   - append(projectDir, entry): CLI path. Shape unchanged.
//   - appendWithContext(projectDir, entry, ctx): plugin path. Adds
//     `plugin_id` to the entry when ctx.pluginId is a non-empty string.
//     Per ADR-006 §"Locks y logs" the plugin_id is attributed on the
//     log entry so `history <id>` can identify the calling plugin; it
//     never comes from the caller-supplied input (the adapter injects
//     it from the installed descriptor).
//
// Both helpers share the same validation and the same atomic
// updateState path so the withLock → updateState → append invariant is
// preserved: a single log entry appears per handler call, even when
// ctx.pluginId is set.
//
// One composable helper for the mutation pipeline:
//   - prepareLogEntry(entry, ctx): returns the canonical { ts, ... }
//     shape WITHOUT writing it anywhere. Used by `kernel.mutate`
//     (ADR-011 §1) so it can compose state mutation + log append into a
//     single `writeState` call. The lock is owned by the kernel so
//     `updateState` is intentionally not invoked here.
import { updateState } from "./state.mjs";

function tsField() {
  return new Date().toISOString();
}

function resolvedPluginId(ctx) {
  const pluginId = ctx && typeof ctx.pluginId === "string" ? ctx.pluginId.trim() : "";
  return pluginId.length > 0 ? pluginId : null;
}

// prepareLogEntry — pure helper that returns the canonical log entry
// shape (timestamp + optional plugin_id) without persisting. Used by
// `kernel.mutate` (ADR-011 §1) so it can compose state mutation + log
// append into a single `writeState` call. The lock is owned by the
// kernel so `updateState` is intentionally not invoked here.
//
// Validation responsibility: callers (`append`, `appendWithContext`,
// `kernel.mutate`) MUST validate the entry shape before passing it
// in. `prepareLogEntry` assumes the entry has been validated.
export function prepareLogEntry(entry, ctx = {}) {
  if (!entry || typeof entry !== "object") {
    throw new Error("prepareLogEntry: entry must be an object");
  }
  if (!entry.action) {
    throw new Error("prepareLogEntry: entry.action is required");
  }
  if (!entry.agent) {
    throw new Error("prepareLogEntry: entry.agent is required");
  }
  const pluginId = resolvedPluginId(ctx);
  const out = { ts: tsField(), ...entry };
  if (pluginId) out.plugin_id = pluginId;
  return out;
}

function validateAppendEntry(entry, commandName = "append") {
  if (!entry || typeof entry !== "object") {
    throw new Error("append: entry must be an object");
  }
  if (!entry.action) {
    throw new Error("append: entry.action is required");
  }
  if (!entry.agent) {
    throw new Error("append: entry.agent is required");
  }
  // Keep the argument in the helper signature for callers that provide a
  // command label, while append errors retain their stable prefix.
  void commandName;
}

export async function append(projectDir, entry) {
  validateAppendEntry(entry, "append");
  return updateState(projectDir, (s) => {
    s.log = s.log || [];
    s.log.push(prepareLogEntry(entry));
    return s;
  });
}

export async function appendWithContext(projectDir, entry, ctx = {}) {
  // ctx is intentionally opaque; only pluginId is recognised. It is trimmed
  // and validated as a string so a falsy, blank or non-string value does NOT inject
  // plugin_id into the log entry.
  validateAppendEntry(entry, "appendWithContext");
  const enriched = prepareLogEntry(entry, ctx);
  return append(projectDir, enriched);
}
