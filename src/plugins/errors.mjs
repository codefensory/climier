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
// right shape without polluting `V2_ERROR_CODES` in src/contracts/errors.mjs.
//
// The pattern mirrors `throwV2` (see src/contracts/errors.mjs) but is intentionally
// separate: plugin codes are only meaningful to the plugin host and the
// lifecycle pair (install/uninstall) — keeping them out of V2_ERROR_CODES
// preserves the contract of the core v2 schema.

import { makeError } from "../contracts/errors.mjs";

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

// ---- ADR-006 §"Errores" — core V2 plugin actions -----------------
//
// These errors are emitted by the core V2 adapter (`core.run`) before
// or after invoking a core handler on behalf of a plugin. They share
// the same envelope shape used by the rest of the PLUGIN_* family
// (`{ code, message, details }`) and stay out of `V2_ERROR_CODES` in
// src/contracts/errors.mjs for the same reason the rest of the family does:
// core v2 codes are an open set consumed by the core; PLUGIN_ codes
// belong to the plugin host, which is a strict subset. The narrow
// `PLUGIN_CORE_*` namespace identifies "the core adapter rejected
// or failed a plugin-issued action" and is preserved verbatim by
// `dispatchPlugin` (no rewrap into `PLUGIN_HANDLER_FAILED`).

// PluginCoreInvalidOperation — the operation does not exist in the
// registry or the input shape cannot be mapped. Emitted before any
// lock is taken, so it never mutates state. `supported` carries the
// canonical list of op names exposed for this slice; `reason` is a
// machine-friendly hint for the orchestrator/operator (e.g.
// "unknown operation", "input.as is forbidden", "input must be an
// object").
export class PluginCoreInvalidOperation extends PluginError {
  constructor(pluginId, op, supported, reason) {
    super(
      "PLUGIN_CORE_INVALID_OPERATION",
      `plugin-core: operation '${op}' is not supported`,
      {
        plugin_id: pluginId,
        op,
        supported: Array.isArray(supported) ? supported.slice() : [],
        reason: typeof reason === "string" ? reason : "unknown operation",
      },
    );
  }
}

// PluginCoreActionFailed — a core handler rejected the action. The
// `cause` is the structured `{ code, message, details }` envelope
// from the underlying core error; if the core threw something opaque
// (no `.code` or no `.details`), the cause is normalized to
// `code: "CORE_ERROR"` so the envelope is always JSON-serializable.
// Emitted after the handler ran, so it MAY have left state behind;
// partial sequences are the plugin's responsibility per ADR-006
// §"Secuencias parciales".
export class PluginCoreActionFailed extends PluginError {
  constructor(pluginId, op, cause) {
    const causeObj = normalizeCoreCause(cause);
    super(
      "PLUGIN_CORE_ACTION_FAILED",
      `plugin-core: operation '${op}' failed: ${causeObj.message}`,
      {
        plugin_id: pluginId,
        op,
        cause: causeObj,
      },
    );
  }
}

// normalizeCoreCause — pull a JSON-safe `{code, message, details}`
// from any error-like value the core handler threw.
function normalizeCoreCause(cause) {
  if (cause && typeof cause.code === "string" && cause.details !== undefined) {
    return {
      code: cause.code,
      message: typeof cause.message === "string" ? cause.message : String(cause.message ?? ""),
      details: safeDetails(cause.details),
    };
  }
  // Strings or other fallbacks land as CORE_ERROR with empty details.
  const message =
    cause && cause.message
      ? cause.message
      : typeof cause === "string"
      ? cause
      : String(cause ?? "(unknown)");
  return { code: "CORE_ERROR", message, details: {} };
}

function safeDetails(details) {
  if (details === null || details === undefined) return {};
  try {
    JSON.parse(JSON.stringify(details));
    return details;
  } catch {
    return {};
  }
}

// wrapCoreError — central mapping used by the adapter inside `core.run`
// to convert any non-PLUGIN_* thrown by a handler into a
// `PLUGIN_CORE_ACTION_FAILED`. Existing PLUGIN_* errors are short-
// circuited by the caller (isPluginError) and re-thrown as-is; this
// helper never sees them.
export function wrapCoreError(pluginId, op, err) {
  return new PluginCoreActionFailed(pluginId, op, err);
}

// isPluginCoreError — narrow predicate for code paths that must
// distinguish `PLUGIN_CORE_*` from the rest of the PLUGIN_* family
// (e.g. tests asserting that dispatch does not rewrap them). It is
// intentionally a superset-defining filter on the `PLUGIN_CORE_`
// prefix and is NOT consulted by `dispatchPlugin`: dispatch uses the
// broader `isPluginError` so no PLUGIN_* envelope is rewritten.
export function isPluginCoreError(err) {
  return Boolean(
    err &&
    typeof err.code === "string" &&
    err.code.startsWith("PLUGIN_CORE_") &&
    err.details !== undefined,
  );
}

// ---- ADR-007 §"Errores" — policy plugin namespace -------------------
//
// Errors emitted by `src/plugins/policy.mjs` for runtime decisions on
// `applies`/`authorize`. Shape contract:
//
//   POLICY_DENIED   decision === "deny"   → handler aborts mutation
//   POLICY_ERROR    exception or invalid response → handler aborts mutation
//   POLICY_CONFLICT selection failed or >1 applicable → handler aborts mutation
//
// Shape validation failures of `default.policy` at load time use the
// existing `PLUGIN_LOAD_FAILED` (see `src/plugin-descriptor.mjs`),
// matching the same re-use pattern as other descriptor shapes
// (ADR-007 §"Errores" reserves POLICY_LOAD_FAILED only for runtime
// policy failures; the load-time shape check is shared with
// descriptor). The three classes below cover the remaining codes.

function normalizePolicyCause(cause) {
  if (!cause) return { code: null, message: null };
  if (typeof cause === "string") {
    return { code: null, message: cause };
  }
  if (typeof cause === "object") {
    return {
      code: typeof cause.code === "string" ? cause.code : null,
      message: typeof cause.message === "string" ? cause.message : null,
    };
  }
  return { code: null, message: String(cause) };
}

// PolicyDenied — the policy explicitly returned
// `{ decision: "deny", reason }`. The handler MUST abort the
// mutation; state must remain intact.
export class PolicyDenied extends PluginError {
  constructor(pluginId, action, actor, reason) {
    super(
      "POLICY_DENIED",
      `policy: plugin '${pluginId}' denied action '${action}' for actor '${actor}': ${reason}`,
      {
        plugin_id: pluginId,
        op: action,
        action,
        reason: typeof reason === "string" ? reason : null,
        actor,
      },
    );
  }
}

// PolicyError — `applies`/`authorize` threw, or returned a response
// that does not match `{ decision: "allow"|"deny"|"abstain" }`. The
// handler MUST abort the mutation; state must remain intact. The
// original cause (if any) is preserved as `cause_message` so the
// orchestrator/operator can attribute the failure.
export class PolicyError extends PluginError {
  constructor(pluginId, action, cause) {
    const normalized = normalizePolicyCause(cause);
    const causeMessage = normalized.message ?? "(unknown)";
    super(
      "POLICY_ERROR",
      `policy: plugin '${pluginId}' raised an error during action '${action}': ${causeMessage}`,
      {
        plugin_id: pluginId,
        op: action,
        action,
        cause_code: normalized.code,
        cause_message: causeMessage,
      },
    );
  }
}

// PolicyConflict — selection could not pick a single applicable
// policy. Either more than one candidate applied, or the single
// candidate raised during `applies`. The handler MUST abort the
// mutation. The list of plugin_ids and namespaces is included so the
// orchestrator can disambiguate, plus a cause_message when
// selection failed for a non-multi-applicable reason.
export class PolicyConflict extends PluginError {
  constructor(pluginIds, namespaces, causeMessage = null) {
    const ids = Array.isArray(pluginIds) ? pluginIds.slice() : [];
    const ns = Array.isArray(namespaces) ? namespaces.slice() : [];
    const reason = causeMessage
      ? `selection failed: ${causeMessage}`
      : `${ids.length} applicable policies conflict`;
    super(
      "POLICY_CONFLICT",
      `policy: ${reason} (${ids.join(", ") || "(none)"})`,
      {
        plugin_ids: ids,
        namespaces: ns,
        cause_message: typeof causeMessage === "string" ? causeMessage : null,
      },
    );
  }
}