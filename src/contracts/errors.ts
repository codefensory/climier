export const CLI_EXIT_CODES = Object.freeze({ SUCCESS: 0, FAILURE: 1, USAGE: 2 });

const CORE_ERROR_CODES = Object.freeze({
  NODE_NOT_FOUND: "NODE_NOT_FOUND",
  INITIATIVE_NOT_FOUND: "INITIATIVE_NOT_FOUND",
  ID_CONFLICT: "ID_CONFLICT",
  INVALID_EDGE_TARGET: "INVALID_EDGE_TARGET",
  INVALID_EDGE_KIND: "INVALID_EDGE_KIND",
  INVALID_EDGE_TYPE: "INVALID_EDGE_TYPE",
  SELF_EDGE: "SELF_EDGE",
  CYCLE_DETECTED: "CYCLE_DETECTED",
  DUPLICATE_EDGE: "DUPLICATE_EDGE",
  MISSING_AGENT: "MISSING_AGENT",
  MISSING_FIELD: "MISSING_FIELD",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  STATE_REVISION_CONFLICT: "STATE_REVISION_CONFLICT",
  INVALID_EXECUTION_CONTRACT: "INVALID_EXECUTION_CONTRACT",
  NOT_READY: "NOT_READY",
  NOT_CLAIMABLE: "NOT_CLAIMABLE",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  NOT_OWNER: "NOT_OWNER",
  INVALID_STATUS: "INVALID_STATUS",
});

const STORAGE_ERROR_CODES = Object.freeze({
  CLIMIER_CORRUPT_LEDGER: "CLIMIER_CORRUPT_LEDGER",
  CLIMIER_CORRUPT_PROJECT_META: "CLIMIER_CORRUPT_PROJECT_META",
  CLIMIER_CORRUPT_STATE: "CLIMIER_CORRUPT_STATE",
  CLIMIER_FENCED_BOOTSTRAP_EXISTS: "CLIMIER_FENCED_BOOTSTRAP_EXISTS",
  CLIMIER_INCOMPATIBLE_VERSION: "CLIMIER_INCOMPATIBLE_VERSION",
  CLIMIER_INVALID_LEDGER: "CLIMIER_INVALID_LEDGER",
  CLIMIER_INVALID_LOCK_CONTEXT: "CLIMIER_INVALID_LOCK_CONTEXT",
  CLIMIER_LEDGER_FINGERPRINT_MISMATCH: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH",
  CLIMIER_LEDGER_MISSING: "CLIMIER_LEDGER_MISSING",
  CLIMIER_LEDGER_PENDING_OPERATION: "CLIMIER_LEDGER_PENDING_OPERATION",
  CLIMIER_LEDGER_REQUIRED: "CLIMIER_LEDGER_REQUIRED",
  CLIMIER_LEDGER_STATE_MISMATCH: "CLIMIER_LEDGER_STATE_MISMATCH",
  CLIMIER_OLD_MIGRATION_PENDING: "CLIMIER_OLD_MIGRATION_PENDING",
  CLIMIER_STATE_NOT_READABLE: "CLIMIER_STATE_NOT_READABLE",
  CLIMIER_UNSUPPORTED_SOURCE_VERSION: "CLIMIER_UNSUPPORTED_SOURCE_VERSION",
});

const REMOTE_ERROR_CODES = Object.freeze({
  REMOTE_BACKEND_REQUIRED: "REMOTE_BACKEND_REQUIRED",
  REMOTE_CONFIG_OUTDATED: "REMOTE_CONFIG_OUTDATED",
  REMOTE_HTTP_ERROR: "REMOTE_HTTP_ERROR",
  REMOTE_INSECURE_ORIGIN: "REMOTE_INSECURE_ORIGIN",
  REMOTE_INVALID_RESPONSE: "REMOTE_INVALID_RESPONSE",
  REMOTE_PROJECT_ID_REQUIRED: "REMOTE_PROJECT_ID_REQUIRED",
  REMOTE_REQUEST_FAILED: "REMOTE_REQUEST_FAILED",
  REMOTE_TIMEOUT: "REMOTE_TIMEOUT",
  REMOTE_UNSUPPORTED_OPERATION: "REMOTE_UNSUPPORTED_OPERATION",
});

const PLUGIN_ERROR_CODES = Object.freeze({
  PLUGIN_API_INCOMPATIBLE: "PLUGIN_API_INCOMPATIBLE",
  PLUGIN_CORE_ACTION_FAILED: "PLUGIN_CORE_ACTION_FAILED",
  PLUGIN_CORE_INVALID_OPERATION: "PLUGIN_CORE_INVALID_OPERATION",
  PLUGIN_HANDLER_FAILED: "PLUGIN_HANDLER_FAILED",
  PLUGIN_INVALID_DESCRIPTOR: "PLUGIN_INVALID_DESCRIPTOR",
  PLUGIN_LOAD_FAILED: "PLUGIN_LOAD_FAILED",
});

const CLI_ERROR_CODES = Object.freeze({
  STORAGE_ERROR: "STORAGE_ERROR",
  CLI_USAGE_ERROR: "CLI_USAGE_ERROR",
  CLI_INTERNAL_ERROR: "CLI_INTERNAL_ERROR",
});

/** The legacy public name for the core error catalog. */
export const V2_ERROR_CODES = CORE_ERROR_CODES;
export { CLI_ERROR_CODES, STORAGE_ERROR_CODES, REMOTE_ERROR_CODES, PLUGIN_ERROR_CODES };

export const ERROR_CODES_BY_DOMAIN = Object.freeze({
  core: V2_ERROR_CODES,
  storage: STORAGE_ERROR_CODES,
  remote: REMOTE_ERROR_CODES,
  plugin: PLUGIN_ERROR_CODES,
  cli: CLI_ERROR_CODES,
});

/** The one runtime catalog from which the public error-code contract is derived. */
export const ERROR_CODES = Object.freeze({
  ...V2_ERROR_CODES,
  ...STORAGE_ERROR_CODES,
  ...REMOTE_ERROR_CODES,
  ...PLUGIN_ERROR_CODES,
  ...CLI_ERROR_CODES,
});

export type CoreErrorCode = (typeof V2_ERROR_CODES)[keyof typeof V2_ERROR_CODES];
export type CanonicalStorageErrorCode = (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];
export type CanonicalRemoteErrorCode = (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES];
export type CanonicalPluginErrorCode = (typeof PLUGIN_ERROR_CODES)[keyof typeof PLUGIN_ERROR_CODES];
export type CliErrorCode = (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];

/** Node filesystem codes are transport details, but still part of storage errors. */
export type StorageSystemErrorCode =
  | "ENOENT"
  | "EACCES"
  | "EBUSY"
  | "EIO"
  | "ENOSPC"
  | "ENOTDIR"
  | "EPERM"
  | "EROFS"
  | "ETIMEDOUT";

/** Prefix extensions keep the boundary compatible while individual domains migrate. */
export type StorageErrorCode = CanonicalStorageErrorCode | StorageSystemErrorCode | `CLIMIER_${string}`;
export type RemoteErrorCode = CanonicalRemoteErrorCode | `REMOTE_${string}` | `TRANSFER_${string}`;
export type PluginErrorCode = CanonicalPluginErrorCode | `PLUGIN_${string}` | `POLICY_${string}`;
export type ErrorCode = CoreErrorCode | StorageErrorCode | RemoteErrorCode | PluginErrorCode | CliErrorCode;

export type ErrorDetails = Record<string, unknown>;

declare global {
  interface Error {
    code?: string;
    details?: ErrorDetails;
  }
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetails;
  };
}

export class ClimierError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClimierError";
    this.code = code;
    this.details = details;
  }

  toJSON(): ErrorEnvelope {
    return makeError(this.code, this.message, this.details);
  }
}

export function makeError(code: ErrorCode, message: string, details: ErrorDetails = {}): ErrorEnvelope {
  return { ok: false, error: { code, message, details } };
}

const STORAGE_SYSTEM_ERROR_CODES = new Set<StorageSystemErrorCode>([
  "ENOENT", "EACCES", "EBUSY", "EIO", "ENOSPC", "ENOTDIR",
  "EPERM", "EROFS", "ETIMEDOUT",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCodeOf(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export function isStorageError(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code && (STORAGE_SYSTEM_ERROR_CODES.has(code as StorageSystemErrorCode)
      || Object.prototype.hasOwnProperty.call(STORAGE_ERROR_CODES, code))) {
    return true;
  }
  return isRecord(error) && typeof error.message === "string"
    && /^(?:state|readState|writeState|lock):/.test(error.message);
}

function safeDetails(details: unknown): ErrorDetails {
  if (!isRecord(details)) {
    return {};
  }
  try {
    JSON.stringify(details);
    return details;
  } catch {
    return {};
  }
}

function errorCode(error: unknown, fallbackCode: ErrorCode): ErrorCode {
  if (isStorageError(error)) {
    return CLI_ERROR_CODES.STORAGE_ERROR;
  }
  const code = errorCodeOf(error);
  return (code || fallbackCode) as ErrorCode;
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error ?? "Unknown error");
}

function withStorageCause(details: ErrorDetails, originalCode: string | undefined): ErrorDetails {
  if (!originalCode || Object.prototype.hasOwnProperty.call(details, "cause")) {
    return details;
  }
  return { ...details, cause: originalCode };
}

/** Normalize any thrown value at the CLI boundary without exposing a stack. */
export function normalizeCliError(
  error: unknown,
  { fallbackCode = CLI_ERROR_CODES.CLI_INTERNAL_ERROR }: { fallbackCode?: ErrorCode } = {},
): { code: ErrorCode; message: string; details: ErrorDetails } {
  const originalCode = errorCodeOf(error);
  const storage = isStorageError(error);
  const code = errorCode(error, fallbackCode);
  const message = errorMessage(error);
  let details = safeDetails(isRecord(error) ? error.details : undefined);
  if (storage) {
    details = withStorageCause(details, originalCode);
  }
  return { code, message, details };
}

export function exitCodeForError(error: unknown): number {
  const code = errorCodeOf(error);
  return code === CLI_ERROR_CODES.CLI_USAGE_ERROR || code === "USAGE_ERROR"
    ? CLI_EXIT_CODES.USAGE
    : CLI_EXIT_CODES.FAILURE;
}

export function throwV2(code: ErrorCode, message: string, details: ErrorDetails = {}): never {
  throw new ClimierError(code, message, details);
}

export type CodedError = Error & { code: string; details?: ErrorDetails; cause?: unknown };

export function codedError(
  code: string,
  message: string,
  details?: ErrorDetails,
  cause?: unknown,
): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

export type CaughtError = Error & { code?: string; details?: ErrorDetails; cause?: unknown };

export function asCaughtError(error: unknown): CaughtError {
  return error as CaughtError;
}
