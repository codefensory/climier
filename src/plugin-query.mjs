// plugin-query.mjs: read-only adapters over the v2 commands.
//
// Each adapter calls the corresponding command with statePath=projectDir
// and the appropriate positional/flags. The commands read via
// readState(projectDir) without taking the project lock, which is exactly
// what the ADR-005 §"API y persistencia" requires for query.*:
//
//   api.query.node(id)            → show
//   api.query.context(id)         → context (with --as=runtime.agent)
//   api.query.status(options)     → status
//   api.query.history(id, opts?)  → history
//
// query.context uses the runtime agent so allowed_actions is scoped to
// the caller (see ADR-005 §"API y persistencia": "query.context usa la
// identidad runtime"). The runtime agent is propagated via flags.as the
// same way the bin/cli path does for v2.

import show from "./commands/show.mjs";
import context from "./commands/context.mjs";
import statusV2 from "./commands/status.mjs";
import history from "./commands/history.mjs";

// knownFlags mirrors of the underlying commands so we can surface a clear
// error when a caller passes a typo.
const STATUS_FLAGS = new Set([
  "initiative",
  "kind",
  "status",
  "domain",
  "claimed-by",
  "stale-ms",
  "limit",
  "all",
  "as",
]);

const HISTORY_FLAGS = new Set(["limit"]);

function asFlags(options, allowed) {
  const flags = {};
  if (!options || typeof options !== "object") return flags;
  for (const [k, v] of Object.entries(options)) {
    if (!allowed.has(k)) {
      const sorted = [...allowed].sort();
      throw new Error(`query: unknown option '${k}' (allowed: ${sorted.join(", ")})`);
    }
    flags[k] = v;
  }
  return flags;
}

export function createQuery({ projectDir, agent }) {
  return {
    node(id) {
      if (typeof id !== "string" || !id) {
        throw new Error("query.node: id required");
      }
      return show({ statePath: projectDir, positional: [id], flags: {} });
    },
    context(id) {
      if (typeof id !== "string" || !id) {
        throw new Error("query.context: id required");
      }
      const flags = {};
      if (typeof agent === "string" && agent) flags.as = agent;
      return context({ statePath: projectDir, positional: [id], flags });
    },
    status(options) {
      return statusV2({ statePath: projectDir, flags: asFlags(options || {}, STATUS_FLAGS) });
    },
    history(id, options) {
      if (typeof id !== "string" || !id) {
        throw new Error("query.history: id required");
      }
      return history({
        statePath: projectDir,
        positional: [id],
        flags: asFlags(options || {}, HISTORY_FLAGS),
      });
    },
  };
}
