// T-plugin-dispatch — plugin error envelope helper.
//
// ADR-005 §"Dispatch y contrato de errores":
//   Errores de descriptor, instalación, carga, datos y handler usan el
//   envelope JSON existente:
//     { ok: false, error: { code, message, details } }
//   con exit 1.
//
// The CLI bin already serializes any thrown error with `.code` and
// `.details` into the structured envelope. This module is a small
// factory for the PLUGIN_* errors so dispatch/load can throw with the
// right shape without polluting `V2_ERROR_CODES` in src/errors.mjs.
//
// The pattern mirrors `throwV2` (see src/errors.mjs) but is intentionally
// separate: plugin codes are only meaningful to the plugin host and the
// lifecycle pair (install/uninstall) — keeping them out of V2_ERROR_CODES
// preserves the contract of the core v2 schema.

import { makeError } from "./errors.mjs";

// pluginErrorEnvelope — pure helper, used by toJSON on each plugin error.
export function pluginErrorEnvelope(code, message, details) {
  return makeError(code, message, details);
}

// PluginError — base class for all PLUGIN_* errors. Subclasses set
// `code` and `details` via the parent constructor.
export class PluginError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
    this.toJSON = () => pluginErrorEnvelope(code, message, details);
  }
}

// PluginSubcommandNotFound — namespace is installed but the requested
// subcommand is missing (either none was given, or `commands[sub]`
// does not exist).
export class PluginSubcommandNotFound extends PluginError {
  constructor(namespace, subcommand) {
    super(
      "PLUGIN_SUBCOMMAND_NOT_FOUND",
      `plugin-dispatch: namespace '${namespace}' has no subcommand '${subcommand ?? ""}'`,
      { namespace, subcommand: subcommand ?? null },
    );
  }
}

// PluginHandlerFailed — handler rejected (sync throw or async reject).
// Details carry plugin_id, namespace, subcommand and the original
// `cause` message so the orchestrator/operator can attribute the
// failure without re-running the plugin.
export class PluginHandlerFailed extends PluginError {
  constructor(namespace, subcommand, cause) {
    const causeMessage =
      cause && cause.message
        ? cause.message
        : typeof cause === "string"
        ? cause
        : String(cause ?? "(unknown)");
    super(
      "PLUGIN_HANDLER_FAILED",
      `plugin-dispatch: handler '${namespace} ${subcommand}' failed: ${causeMessage}`,
      {
        plugin_id: namespace,
        namespace,
        subcommand,
        cause: causeMessage,
      },
    );
  }
}

// PluginAgentMissing — the host could not resolve an agent for this
// dispatch. Surfaces as PLUGIN_HANDLER_FAILED because the failure is
// "we cannot set up the handler call"; agent resolution lives in
// dispatch, not in the handler itself.
export class PluginAgentMissing extends PluginHandlerFailed {
  constructor(namespace) {
    super(namespace, "(dispatch)", new Error("agent required (pass --as <agent> or set CLIMIER_AGENT)"));
    // Override details to keep plugin_id/namespace consistent.
    this.details = {
      plugin_id: namespace,
      namespace,
      subcommand: null,
      cause: "agent required (pass --as <agent> or set CLIMIER_AGENT)",
    };
  }
}

// throwPluginError — bare factory for ad-hoc PLUGIN_* throws that do not
// match a named subclass. Used by callers that need to emit a code we
// have not specialized above (e.g. PLUGIN_LOAD_FAILED when surfacing a
// non-class error from the loader). Mirrors throwV2 from errors.mjs.
export function throwPluginError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  err.toJSON = () => pluginErrorEnvelope(code, message, details);
  throw err;
}

// isPluginError — predicate for handlers that want to short-circuit
// rewrapping (used by plugin-dispatch.mjs to avoid double-wrapping
// existing PLUGIN_* errors thrown from a handler).
export function isPluginError(err) {
  return (
    err &&
    typeof err.code === "string" &&
    err.code.startsWith("PLUGIN_") &&
    err.details !== undefined
  );
}