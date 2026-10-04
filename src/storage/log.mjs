// log.mjs: append entries to the global state log.
// Two entry points:
//   - append(projectDir, entry): CLI path. Shape unchanged.
//   - appendWithContext(projectDir, entry, ctx): plugin path. Adds
//     `plugin_id` to the entry when ctx.pluginId is a non-empty string.


//     never comes from the caller-supplied input (the adapter injects
//     it from the installed descriptor).
// Both helpers share the same validation and the same atomic ledger
// commit, so a single log entry appears per handler call, even when
// ctx.pluginId is set.
// One composable helper for the mutation pipeline:
//   - prepareLogEntry(entry, ctx): returns the canonical { ts, ... }
//     shape WITHOUT writing it anywhere. Used by `kernel.mutate`

//     single ledger commit owned by the kernel.
import { emptyState, stateFile } from "./state.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { withLock } from "./lock.mjs";
import {
  bootstrapFencedStateUnderLock,
  commitFencedStateUnderLock,
  readFencedStateUnderLock,
} from "./ledger.mjs";

function tsField() {
  return new Date().toISOString();
}

function resolvedPluginId(ctx) {
  const pluginId = ctx && typeof ctx.pluginId === "string" ? ctx.pluginId.trim() : "";
  return pluginId.length > 0 ? pluginId : null;
}

// prepareLogEntry — pure helper that returns the canonical log entry
// shape (timestamp + optional plugin_id) without persisting. Used by

// append into a single ledger commit owned by the kernel.
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
  if (pluginId) {
    out.plugin_id = pluginId;
  }
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

  void commandName;
}

export async function append(projectDir, entry) {
  validateAppendEntry(entry, "append");
  const preparedEntry = prepareLogEntry(entry);
  return withLock(projectDir, async (lockContext) => {
    let state;
    try {
      state = await readFencedStateUnderLock(lockContext, { projectDir });
    } catch (error) {
      if (error.code !== "CLIMIER_LEDGER_STATE_MISMATCH") { throw error; }
    }
    if (!state) {
      state = { ...emptyState(), log: [preparedEntry] };
      let hasState = true;
      try { await fs.access(stateFile(projectDir)); }
      catch (error) { if (error.code === "ENOENT") { hasState = false; } else { throw error; } }
      let hasLedger = true;
      try { await fs.access(path.join(path.dirname(stateFile(projectDir)), "revision-ledger.json")); }
      catch (error) { if (error.code === "ENOENT") { hasLedger = false; } else { throw error; } }
      if (hasLedger) { throw new Error("append: cannot initialize over a corrupt ledger-backed state"); }
      if (hasState) { throw new Error("append: cannot initialize over a corrupt state without explicit recovery"); }
      return bootstrapFencedStateUnderLock(lockContext, state, { projectDir });
    }
    const next = {
      ...state,
      revision: state.revision + 1,
      log: [...(Array.isArray(state.log) ? state.log : []), preparedEntry],
    };
    return commitFencedStateUnderLock(lockContext, next, { projectDir });
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
