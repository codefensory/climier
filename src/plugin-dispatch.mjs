// T-plugin-dispatch — plugin dispatch orchestration (ADR-005 §"Dispatch
// y contrato de errores" + §"Discovery, namespaces y dispatch").
//
// Inputs:
//   originalArgv — full argv (process.argv.slice(2)) so we can preserve
//                  the original order of all tokens, including flags
//                  placed before the namespace.
//   namespace    — first non-flag token, already resolved by the bin.
//   projectDir   — effective project root, used only as a fallback when
//                  --project was not passed in argv at all.
//   flags        — parsed flags object from the bin (kept for back-compat
//                  with the bin's core dispatch path; NOT consulted for
//                  the host's effective project_dir / agent because the
//                  bin's parser uses last-wins and would let a forwarded
//                  duplicate alter the host's resolution).
//   createApi    — optional factory injected by the caller. When omitted,
//                  the dispatcher lazy-imports ./plugin-api.mjs. If that
//                  module is missing (T-plugin-api is parallel), a
//                  placeholder factory is used that satisfies the
//                  runtime contract but throws on every query/data call.
//
// Algorithm:
//   1. loadInstalledPlugin(namespace)
//   2. findStripIndices(originalArgv, namespace) — first non-flag after
//      the namespace is the subcommand.
//   3. Validate commands[subcommand] is a function. Throw
//      PLUGIN_SUBCOMMAND_NOT_FOUND otherwise.
//   4. Build forwardedTokens by removing the namespace + subcommand
//      positions from originalArgv.
//   5. Resolve effective project_dir and agent from originalArgv
//      (first-wins). This makes api.runtime immune to duplicate
//      --project/--as tokens in the forwarded tail.
//   6. createApi({ projectDir, agent, pluginId }) → api.
//   7. await commands[subcommand](forwardedTokens, api).
//      Handler errors → PLUGIN_HANDLER_FAILED with namespace/subcommand
//      in details. Existing PLUGIN_* errors are propagated without
//      rewrapping.

import path from "node:path";

import {
  PluginAgentMissing,
  PluginHandlerFailed,
  PluginSubcommandNotFound,
  isPluginError,
} from "./plugin-errors.mjs";
import { loadInstalledPlugin } from "./plugins/loader.mjs";

// ---- Token stripping ------------------------------------------------

// Boolean flags that do NOT consume the next argv token as their value.
// Mirrors the parser in bin/climier.mjs so the dispatcher can walk
// originalArgv and identify non-flag tokens.
const BOOLEAN_FLAGS = new Set(["all", "force"]);

// findStripIndices — walks `argv` and returns the array indices of the
// namespace token and the next non-flag token (subcommand).
//
// The bin already knows `namespace` from its own parser; this function
// is the dispatcher's authoritative walk over `originalArgv` because
// it must understand boolean flags to correctly identify which argv
// positions are flag values (consumed) and which are positional tokens.
export function findStripIndices(argv, namespace) {
  const indices = [];
  let namespaceSeen = false;
  let subcommandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== "string" || !tok) continue;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const key = eq !== -1 ? tok.slice(2, eq) : tok.slice(2);
      const isBool = BOOLEAN_FLAGS.has(key);
      if (!isBool && eq === -1) {
        // Value flag: consume next token unless it looks like another flag.
        const next = argv[i + 1];
        if (next !== undefined && !String(next).startsWith("--")) i++;
      }
      continue;
    }
    if (!namespaceSeen) {
      if (tok === namespace) {
        indices.push(i);
        namespaceSeen = true;
      }
      continue;
    }
    if (!subcommandSeen) {
      indices.push(i);
      subcommandSeen = true;
      break;
    }
  }
  return indices;
}

// stripAtIndices — returns a new array with the given positions removed.
// Preserves the original order of the remaining tokens.
export function stripAtIndices(argv, indices) {
  if (!indices || indices.length === 0) return argv.slice();
  const set = new Set(indices);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (!set.has(i)) out.push(argv[i]);
  }
  return out;
}

// ---- Host flag resolution -------------------------------------------

// findFirstFlagValue — walks argv and returns the value of the FIRST
// occurrence of `--<flag>` (or `--<flag>=<value>`). The host resolves
// `--project` and `--as` from `originalArgv` (not from the bin's flags
// object) so that any duplicate occurrences in the forwarded tail
// cannot alter the effective values used by `api.runtime`. The bin's
// argv parser uses last-wins for flags, so relying on its `flags`
// object would let a forwarded `--project /tmp/elsewhere` overwrite the
// host's effective project_dir.
export function findFirstFlagValue(argv, flagName) {
  const eqPrefix = `--${flagName}=`;
  const exact = `--${flagName}`;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== "string") continue;
    if (tok.startsWith(eqPrefix)) {
      return tok.slice(eqPrefix.length);
    }
    if (tok === exact) {
      // Value follows in the next argv slot unless it looks like another
      // flag. Boolean `--<flag>` is treated as no-value.
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) return next;
      return null;
    }
  }
  return null;
}

// resolveEffectiveProjectDir — host resolution of --project. Falls back
// to the bin-supplied `projectDir` only when the user did not pass
// --project in argv at all (this is the common case and matches the
// behavior the bin already uses for core commands).
export function resolveEffectiveProjectDir(argv, fallback) {
  const v = findFirstFlagValue(argv || [], "project");
  if (v && String(v).trim()) return path.resolve(String(v).trim());
  return fallback;
}

// resolveEffectiveAgent — host resolution of --as with the same
// precedence as resolveAgent (flags.as > CLIMIER_AGENT > error). The
// bin's flags object is ignored on purpose; we read directly from argv
// so forwarded duplicates do not flip identity. Throws
// PLUGIN_HANDLER_FAILED via PluginAgentMissing when no agent resolves.
export function resolveEffectiveAgent(argv, namespace) {
  const v = findFirstFlagValue(argv || [], "as");
  const fromArgv = v && String(v).trim() ? String(v).trim() : "";
  if (fromArgv) return fromArgv;
  const fromEnv =
    typeof process.env.CLIMIER_AGENT === "string" ? process.env.CLIMIER_AGENT.trim() : "";
  if (fromEnv) return fromEnv;
  throw new PluginAgentMissing(namespace);
}

// ---- API seam -------------------------------------------------------

// placeholderApiFactory — used when src/plugin-api.mjs has not been
// merged yet. Exposes a complete `runtime` (the only contract the
// dispatcher must guarantee) and throws a structured
// PLUGIN_HANDLER_FAILED for every query/data access so the failure is
// attributable rather than silent.
function placeholderApiFactory({ projectDir, agent, pluginId }) {
  const notImpl = (key) => () => {
    throw new PluginHandlerFailed(
      pluginId,
      "(dispatch)",
      new Error(`api.${key} not implemented yet (T-plugin-api pending)`),
    );
  };
  return {
    runtime: {
      project_dir: projectDir,
      agent,
      plugin_id: pluginId,
    },
    query: {
      node: notImpl("query.node"),
      context: notImpl("query.context"),
      status: notImpl("query.status"),
      history: notImpl("query.history"),
    },
    data: {
      node: { get: notImpl("data.node.get"), set: notImpl("data.node.set") },
      project: { get: notImpl("data.project.get"), set: notImpl("data.project.set") },
    },
  };
}

// loadApiFactory — lazy import of ./plugin-api.mjs. Caches the
// successful module; falls back to the placeholder on any failure so
// the bin never crashes because the parallel task has not landed.
let _apiFactory = null;
let _apiFactoryResolved = false;
async function loadApiFactory() {
  if (_apiFactoryResolved) return _apiFactory;
  try {
    const mod = await import("./plugin-api.mjs");
    if (mod && typeof mod.createApi === "function") {
      _apiFactory = mod.createApi;
    }
  } catch {
    // Module missing or threw at import time — fall back to placeholder.
  }
  _apiFactoryResolved = true;
  if (!_apiFactory) _apiFactory = placeholderApiFactory;
  return _apiFactory;
}

// resetApiFactoryForTests — re-arms the lazy import so the next call
// re-tries the import. Used by test suites that want to swap in a
// different plugin-api.mjs after a test reset.
export function _resetApiFactoryForTests() {
  _apiFactory = null;
  _apiFactoryResolved = false;
}

// ---- Dispatch --------------------------------------------------------

// dispatchPlugin — orchestrates the lifecycle above. Returns the
// handler's return value (or undefined) so the bin can serialize it
// to stdout.
export async function dispatchPlugin({
  originalArgv,
  namespace,
  projectDir,
  flags = {}, // eslint-disable-line no-unused-vars
  createApi: createApiInjected,
} = {}) {
  // 1. Load installed plugin (lazy ESM import + descriptor validation).
  const { pluginId, commands } = await loadInstalledPlugin(namespace);

  // 2. Identify subcommand in originalArgv.
  const indices = findStripIndices(originalArgv || [], namespace);
  const subcommand = indices.length >= 2 ? originalArgv[indices[1]] : null;

  // 3. Validate subcommand is registered.
  if (!subcommand || typeof subcommand !== "string" || typeof commands[subcommand] !== "function") {
    throw new PluginSubcommandNotFound(namespace, subcommand ?? null);
  }

  // 4. Strip namespace + subcommand from originalArgv.
  const forwardedTokens = stripAtIndices(originalArgv || [], indices);

  // 5. Effective project_dir / agent from originalArgv (first-wins).
  //    The bin's `flags` object is intentionally not consulted for
  //    these two keys because the bin's parser uses last-wins and that
  //    would let forwarded duplicates alter the host's resolution.
  const effectiveProjectDir = resolveEffectiveProjectDir(originalArgv, projectDir);
  const agent = resolveEffectiveAgent(originalArgv, namespace);

  // 6. Build api via injected factory or the lazy/placeholder fallback.
  const createApi = createApiInjected || (await loadApiFactory());
  const api = createApi({ projectDir: effectiveProjectDir, agent, pluginId });

  // 7. Call the handler. Preserve any pre-existing PLUGIN_* envelope;
  // wrap everything else as PLUGIN_HANDLER_FAILED.
  try {
    return await commands[subcommand](forwardedTokens, api);
  } catch (err) {
    if (isPluginError(err)) throw err;
    throw new PluginHandlerFailed(namespace, subcommand, err);
  }
}