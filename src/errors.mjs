// F2 — structured v2 errors.
// Every v2 command throws via throwV2(code, message, details).
// The CLI entry detects the resulting V2Error by err.code + err.details and
// emits { ok: false, error: { code, message, details } } to stdout.

// Claimability codes are deliberately split by cause: NOT_CLAIMABLE means
// the node type cannot be claimed, NOT_READY means a task's state prevents a
// claim, and ALREADY_CLAIMED means another agent owns the requested task.
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
  NOT_READY: "NOT_READY",
  NOT_CLAIMABLE: "NOT_CLAIMABLE",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  NOT_OWNER: "NOT_OWNER",
  INVALID_STATUS: "INVALID_STATUS",
});

export function makeError(code, message, details) {
  return { ok: false, error: { code, message, details } };
}

export function throwV2(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  err.toJSON = () => makeError(code, message, details);
  throw err;
}