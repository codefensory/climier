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
import { updateState } from "./state.mjs";

export async function append(projectDir, entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("append: entry must be an object");
  }
  if (!entry.action) {
    throw new Error("append: entry.action is required");
  }
  if (!entry.agent) {
    throw new Error("append: entry.agent is required");
  }
  return updateState(projectDir, (s) => {
    s.log = s.log || [];
    s.log.push({ ts: new Date().toISOString(), ...entry });
    return s;
  });
}

export async function appendWithContext(projectDir, entry, ctx = {}) {
  // ctx is intentionally opaque here so future extensions (e.g. extra
  // audit metadata) do not require a breaking signature change. Today
  // only pluginId is recognised; it is trimmed and validated as a
  // string so a falsy, blank or non-string value does NOT inject
  // plugin_id into the log entry.
  const pluginId =
    ctx && typeof ctx.pluginId === "string" && ctx.pluginId.trim()
      ? ctx.pluginId.trim()
      : null;
  const enriched = pluginId ? { ...entry, plugin_id: pluginId } : { ...entry };
  return append(projectDir, enriched);
}
