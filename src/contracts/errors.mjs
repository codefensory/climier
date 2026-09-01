// F2 — structured v2 errors.
// Every v2 command throws via throwV2(code, message, details).
// The CLI entry detects the resulting V2Error by err.code + err.details and
// emits { ok: false, error: { code, message, details } } to stdout.

// Claimability codes are deliberately split by cause: NOT_CLAIMABLE means
// the node type cannot be claimed, NOT_READY means a task's state prevents a
// claim, and ALREADY_CLAIMED means another agent owns the requested task.
// Process exit codes are intentionally small and stable for shell callers.
// Operational failures (including domain conflicts and storage/internal errors)
// use 1; command routing failures use 2. Callers must inspect error.code for
// the machine-readable distinction between operational failure classes.
export const CLI_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
});

export const CLI_ERROR_CODES = Object.freeze({
  STORAGE_ERROR: "STORAGE_ERROR",
  CLI_INTERNAL_ERROR: "CLI_INTERNAL_ERROR",
});

export const V2_ERROR_CODES = Object.freeze({
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

export function makeError(code, message, details) {
  return { ok: false, error: { code, message, details } };
}

const STORAGE_ERROR_CODES = new Set([
  "CLIMIER_CORRUPT_PROJECT_META",
  "CLIMIER_CORRUPT_STATE",
  "CLIMIER_INCOMPATIBLE_VERSION",
  "STATE_V1_UNSUPPORTED",
  "ENOENT",
  "EACCES",
  "EBUSY",
  "EIO",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
]);

export function isStorageError(error) {
  if (!error) return false;
  if (typeof error.code === "string" && STORAGE_ERROR_CODES.has(error.code)) return true;
  return typeof error.message === "string" && /^(?:state|readState|writeState|lock):/.test(error.message);
}

function safeDetails(details) {
  if (details === undefined) return {};
  try {
    JSON.stringify(details);
    return details;
  } catch {
    return {};
  }
}

/** Normalize any thrown value at the CLI boundary without exposing a stack. */
export function normalizeCliError(error, { fallbackCode = CLI_ERROR_CODES.CLI_INTERNAL_ERROR } = {}) {
  const originalCode = error && typeof error.code === "string" ? error.code : null;
  const storage = isStorageError(error);
  const code = storage ? CLI_ERROR_CODES.STORAGE_ERROR : (originalCode || fallbackCode);
  const message = error && typeof error.message === "string"
    ? error.message
    : typeof error === "string" ? error : String(error ?? "Unknown error");
  const details = safeDetails(error && error.details);
  if (storage && originalCode && (!details || typeof details !== "object" || Array.isArray(details) || details.cause === undefined)) {
    return {
      code,
      message,
      details: { ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}), cause: originalCode },
    };
  }
  return { code, message, details };
}

export function exitCodeForError(error) {
  return error && (error.code === "CLI_USAGE_ERROR" || error.code === "USAGE_ERROR")
    ? CLI_EXIT_CODES.USAGE
    : CLI_EXIT_CODES.FAILURE;
}

export function throwV2(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  err.toJSON = () => makeError(code, message, details);
  throw err;
}