import type { ErrorCode } from "../contracts/errors.ts";
import { makeError } from "../contracts/errors.ts";
import { isRecord } from "../application/types.ts";

type PluginDetails = Record<string, unknown>;
type PluginErrorShape = Error & { code?: string; details?: unknown };

export function pluginErrorEnvelope(code: ErrorCode, message: string, details: PluginDetails = {}): ReturnType<typeof makeError> {
  return makeError(code, message, details);
}

export class PluginError extends Error {
  readonly code: ErrorCode;
  details: PluginDetails;
  toJSON: () => ReturnType<typeof pluginErrorEnvelope>;

  constructor(code: ErrorCode, message: string, details: PluginDetails = {}) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
    this.toJSON = () => pluginErrorEnvelope(code, message, details);
  }
}

export class PluginSubcommandNotFound extends PluginError {
  constructor(namespace: string, subcommand: string | null) {
    super(
      "PLUGIN_SUBCOMMAND_NOT_FOUND",
      `plugin-dispatch: namespace '${namespace}' has no subcommand '${subcommand ?? ""}'`,
      { namespace, subcommand: subcommand ?? null },
    );
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (isRecord(cause) && typeof cause.message === "string") {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return String(cause ?? "(unknown)");
}

export class PluginHandlerFailed extends PluginError {
  constructor(namespace: string, subcommand: string, cause: unknown) {
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
  constructor(namespace: string) {
    super(namespace, "(dispatch)", new Error("agent required (pass --as <agent> or set CLIMIER_AGENT)"));

    this.details = {
      plugin_id: namespace,
      namespace,
      subcommand: null,
      cause: "agent required (pass --as <agent> or set CLIMIER_AGENT)",
    };
  }
}

export function throwPluginError(code: ErrorCode, message: string, details: PluginDetails = {}): never {
  const err = new Error(message) as PluginErrorShape & { toJSON: () => ReturnType<typeof pluginErrorEnvelope> };
  err.code = code;
  err.details = details;
  err.toJSON = () => pluginErrorEnvelope(code, message, details);
  throw err;
}

export function isPluginError(err: unknown): err is PluginErrorShape {
  return Boolean(
    isRecord(err) &&
    typeof err.code === "string" &&
    err.code.startsWith("PLUGIN_") &&
    err.details !== undefined
  );
}

export class PluginCoreInvalidOperation extends PluginError {
  constructor(pluginId: string, op: string, supported: unknown, reason: unknown) {
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
  constructor(pluginId: string, op: string, cause: unknown) {
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

function normalizeCoreCause(cause: unknown): { code: string; message: string; details: PluginDetails } {
  if (isRecord(cause) && typeof cause.code === "string" && cause.details !== undefined) {
    return {
      code: cause.code,
      message: typeof cause.message === "string" ? cause.message : String(cause.message ?? ""),
      details: safeDetails(cause.details),
    };
  }

  return { code: "CORE_ERROR", message: errorMessage(cause), details: {} };
}

function safeDetails(details: unknown): PluginDetails {
  if (!isRecord(details)) {return {};}
  try {
    JSON.parse(JSON.stringify(details));
    return details;
  } catch {
    return {};
  }
}

export function wrapCoreError(pluginId: string, op: string, err: unknown): PluginCoreActionFailed {
  return new PluginCoreActionFailed(pluginId, op, err);
}

export function isPluginCoreError(err: unknown): boolean {
  return Boolean(
    isPluginError(err) &&
    typeof err.code === "string" &&
    err.code.startsWith("PLUGIN_CORE_") &&
    err.details !== undefined,
  );
}

function normalizePolicyCause(cause: unknown): { code: string | null; message: string | null } {
  if (!cause) {return { code: null, message: null };}
  if (typeof cause === "string") {
    return { code: null, message: cause };
  }
  if (isRecord(cause)) {
    return {
      code: typeof cause.code === "string" ? cause.code : null,
      message: typeof cause.message === "string" ? cause.message : null,
    };
  }
  return { code: null, message: String(cause) };
}

export class PolicyDenied extends PluginError {
  constructor(pluginId: string, action: string, actor: string, reason: unknown) {
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
  constructor(pluginId: string, action: string, cause: unknown) {
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
  constructor(pluginIds: unknown, namespaces: unknown, causeMessage: string | null = null) {
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
