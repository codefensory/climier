// T-plugin-core-api — `api.core` surface for plugin V2 (ADR-006).
//
// Creates `createCore({ projectDir, agent, pluginId })` which yields the
// `{ version, run }` object that `createApi` exposes as `api.core`. The
// adapter is intentionally I/O-free except for the handler call:
//   - it never executes argv;
//   - it never opens a lock of its own (the invoked handler keeps its
//     withLock → updateState → append invariant);
//   - it never reads or imports the bin's parser.
//
// Mapping rules (per ADR-006 §"Registry y adaptación" and the bootstrap
// plan §3.4):
//
//   1. Reject before any handler call when:
//        - op is not a registered key in CORE_REGISTRY;
//        - input is missing or not a plain object (arrays/null not allowed);
//        - input carries `as` or `_as` (identity is fixed by the host);
//        - a required field is undefined in input.
//
//   2. Translate input to (positional, flags):
//        - positional: pass through `entry.positional` names, omit
//          undefined slots so add-task can auto-allocate an id when
//          input omits one;
//        - flags: snake → kebab via `entry.snakeToFlag`;
//        - flags.as is fixed to `agent` (api.runtime.agent) and never
//          taken from input.
//
//   3. On handler error:
//        - rethrow any PLUGIN_* error unchanged (isPluginError covers
//          PLUGIN_CORE_* exactly as well — the contract that
//          PLUGIN_CORE_ACTION_FAILED never becomes PLUGIN_HANDLER_FAILED);
//        - otherwise wrap as PLUGIN_CORE_ACTION_FAILED with details.op
//          and a normalized cause (structured envelope when available,
//          CORE_ERROR fallback otherwise).

import { CORE_REGISTRY, SUPPORTED_OPS } from "./plugin-core-registry.mjs";
import {
  PluginCoreInvalidOperation,
  isPluginError,
  wrapCoreError,
} from "./plugin-errors.mjs";

function buildCtxArgs(pluginId, op, input, agent) {
  const entry = CORE_REGISTRY[op];
  if (!entry) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      SUPPORTED_OPS,
      "unknown operation",
    );
  }
  // input: must be a non-null, non-array object.
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      SUPPORTED_OPS,
      "input must be an object",
    );
  }
  // The adapter fixes flags.as from api.runtime.agent; the plugin must
  // never be able to substitute it through input.as (or its alias _as).
  if ("as" in input || "_as" in input) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      SUPPORTED_OPS,
      "input.as is forbidden",
    );
  }

  // Validate required fields. A required field is either positional
  // (named in entry.positional) or a flag (named in entry.snakeToFlag
  // values). Anything missing from input throws BEFORE the handler call
  // so the state cannot be mutated by an obviously incomplete request.
  const flagValueSet = new Set(Object.values(entry.snakeToFlag || {}));
  const positionalSet = new Set(entry.positional);
  for (const req of entry.required) {
    if (positionalSet.has(req)) {
      if (input[req] === undefined) {
        throw new PluginCoreInvalidOperation(
          pluginId,
          op,
          SUPPORTED_OPS,
          `missing required field '${req}'`,
        );
      }
    } else if (flagValueSet.has(req)) {
      // The handler exposes this field under its kebab-case flag name;
      // input must carry the corresponding snake_case key.
      const snakeKey = Object.keys(entry.snakeToFlag).find(
        (k) => entry.snakeToFlag[k] === req,
      );
      if (!snakeKey || input[snakeKey] === undefined) {
        throw new PluginCoreInvalidOperation(
          pluginId,
          op,
          SUPPORTED_OPS,
          `missing required field '${snakeKey || req}'`,
        );
      }
    } else {
      // Required field neither positional nor flag — defensive: refuse
      // rather than silently accept. This branch should not fire on
      // the current first-slice registry.
      throw new PluginCoreInvalidOperation(
        pluginId,
        op,
        SUPPORTED_OPS,
        `missing required field '${req}'`,
      );
    }
  }

  // Build positional: filter undefined so add-task can auto-allocate
  // an id when input omits one. String() coerces numbers/etc. to keep
  // the handler signature stable.
  const positional = entry.positional
    .map((name) =>
      input[name] !== undefined ? String(input[name]) : undefined,
    )
    .filter((v) => v !== undefined);

  // Build flags: snake → kebab mapping, plus the adapter-fixed flags.as.
  const flags = {};
  for (const [snake, kebab] of Object.entries(entry.snakeToFlag || {})) {
    if (input[snake] !== undefined) flags[kebab] = input[snake];
  }
  if (typeof agent === "string" && agent.length > 0) {
    flags.as = agent;
  }

  return { entry, positional, flags };
}

// createCore — exposes api.core: { version: 2, run({ op, input }) }.
//
// contract (ADR-006 §"API y compatibilidad"):
//   - exactly one action per call (no argv, no callback, no batch);
//   - returns the handler's envelope ({ node } / { edge } / ...);
//   - throws PLUGIN_CORE_INVALID_OPERATION before any state mutation;
//   - throws PLUGIN_CORE_ACTION_FAILED for any handler-level failure;
//   - rethrows any PLUGIN_* errors untouched so they do not get wrapped
//     into PLUGIN_HANDLER_FAILED at the dispatch layer.
export function createCore({ projectDir, agent, pluginId }) {
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("createCore: projectDir required");
  }
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createCore: pluginId required");
  }

  return {
    version: 2,

    async run({ op, input } = {}) {
      // op must be a string key in the registry. Anything else
      // (undefined, null, a number, an unknown string) is the same
      // "unknown operation" branch.
      if (typeof op !== "string" || !op) {
        throw new PluginCoreInvalidOperation(
          pluginId,
          typeof op === "string" ? op : "",
          SUPPORTED_OPS,
          "unknown operation",
        );
      }

      let parsed;
      try {
        parsed = buildCtxArgs(pluginId, op, input, agent);
      } catch (err) {
        // PLUGIN_CORE_INVALID_OPERATION only — propagates untouched.
        throw err;
      }

      const { entry, positional, flags } = parsed;
      const ctx = {
        statePath: projectDir,
        projectDir,
        flags,
        positional,
        pluginId,
      };

      try {
        return await entry.handler(ctx);
      } catch (err) {
        // Existing PLUGIN_* envelopes (including PLUGIN_CORE_*) bubble
        // as-is so dispatch.isPluginError short-circuits them and the
        // CLI never rewrites them into PLUGIN_HANDLER_FAILED.
        if (isPluginError(err)) throw err;
        // Anything else is treated as a core-handler failure and gets
        // wrapped with details.op + cause (normalized if opaque).
        throw wrapCoreError(pluginId, op, err);
      }
    },
  };
}
