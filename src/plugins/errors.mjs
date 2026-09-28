
import { makeError } from "../contracts/errors.mjs";

export function pluginErrorEnvelope(code, message, details) {
  return makeError(code, message, details);
}

export class PluginError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
    this.toJSON = () => pluginErrorEnvelope(code, message, details);
  }
}

export class PluginSubcommandNotFound extends PluginError {
  constructor(namespace, subcommand) {
    super(
      "PLUGIN_SUBCOMMAND_NOT_FOUND",
      `plugin-dispatch: namespace '${namespace}' has no subcommand '${subcommand ?? ""}'`,
      { namespace, subcommand: subcommand ?? null },
    );
  }
}

function errorMessage(cause) {
  if (cause && cause.message) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return String(cause ?? "(unknown)");
}

export class PluginHandlerFailed extends PluginError {
  constructor(namespace, subcommand, cause) {
    const causeMessage = errorMessage(cause);
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

export class PluginAgentMissing extends PluginHandlerFailed {
  constructor(namespace) {
    super(namespace, "(dispatch)", new Error("agent required (pass --as <agent> or set CLIMIER_AGENT)"));

    this.details = {
      plugin_id: namespace,
      namespace,
      subcommand: null,
      cause: "agent required (pass --as <agent> or set CLIMIER_AGENT)",
    };
  }
}

export function throwPluginError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  err.toJSON = () => pluginErrorEnvelope(code, message, details);
  throw err;
}

export function isPluginError(err) {
  return (
    err &&
    typeof err.code === "string" &&
    err.code.startsWith("PLUGIN_") &&
    err.details !== undefined
  );
}

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

function normalizeCoreCause(cause) {
  if (cause && typeof cause.code === "string" && cause.details !== undefined) {
    return {
      code: cause.code,
      message: typeof cause.message === "string" ? cause.message : String(cause.message ?? ""),
      details: safeDetails(cause.details),
    };
  }

  return { code: "CORE_ERROR", message: errorMessage(cause), details: {} };
}

function safeDetails(details) {
  if (details === null || details === undefined) {return {};}
  try {
    JSON.parse(JSON.stringify(details));
    return details;
  } catch {
    return {};
  }
}

export function wrapCoreError(pluginId, op, err) {
  return new PluginCoreActionFailed(pluginId, op, err);
}

export function isPluginCoreError(err) {
  return Boolean(
    err &&
    typeof err.code === "string" &&
    err.code.startsWith("PLUGIN_CORE_") &&
    err.details !== undefined,
  );
}

function normalizePolicyCause(cause) {
  if (!cause) {return { code: null, message: null };}
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
