const MAX_BODY_BYTES = 1024 * 1024;

const CONFLICT_CODES = new Set([
  "ID_CONFLICT",
  "REVISION_CONFLICT",
  "STATE_REVISION_CONFLICT",
  "STATE_ALREADY_INITIALIZED",
  "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE",
  "CLIMIER_TRANSFER_PLUGIN_DATA",
  "CLIMIER_INCOMPATIBLE_VERSION",
]);
const UNPROCESSABLE_CODES = new Set([
  "INVALID_NAME",
  "MISSING_FIELD",
  "INVALID_EDGE_TARGET",
  "INVALID_EDGE_KIND",
  "SELF_EDGE",
  "DUPLICATE_EDGE",
  "NOT_READY",
  "INVALID_STATUS",
]);
const NOT_FOUND_CODES = new Set(["OPERATION_NOT_FOUND", "NODE_NOT_FOUND", "INITIATIVE_NOT_FOUND"]);
const FIXED_ERROR_STATUSES = new Map([["UNKNOWN_PROJECT", 404], ["INVALID_PROJECT_ID", 400], ["SERVER_ALREADY_RUNNING", 409]]);
const FORBIDDEN_CODES = new Set(["PROJECT_SCOPE_DENIED", "POLICY_DENIED"]);

function httpError(code, message, details, status) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  error.status = status;
  return error;
}

const ERROR_STATUS_GROUPS = new Map([
  [401, new Set(["AUTH_REQUIRED", "AUTH_INVALID"])],
  [403, FORBIDDEN_CODES],
  [404, NOT_FOUND_CODES],
  [409, CONFLICT_CODES],
  [422, UNPROCESSABLE_CODES],
]);

function standardErrorStatus(code) {
  for (const [status, codes] of ERROR_STATUS_GROUPS) {
    if (codes.has(code)) {
      return status;
    }
  }
  return FIXED_ERROR_STATUSES.get(code) ?? (hasValidationCodePrefix(code) ? 422 : null);
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) {
    return error.status;
  }
  return standardErrorStatus(error?.code) ?? 400;
}

function hasValidationCodePrefix(code) {
  return typeof code === "string"
    && ["MISSING_", "INVALID_", "SELF_", "DUPLICATE_", "NOT_READY"].some((prefix) => code.startsWith(prefix));
}

function jsonError(error) {
  const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
  const message = typeof error?.message === "string" ? error.message : "server http: request failed";
  const body = { ok: false, error: { code, message } };
  if (error?.details !== undefined) {
    body.error.details = error.details;
  }
  return body;
}

function send(response, status, body, options) {
  const { headers = {}, protocolVersion } = options;
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-climier-protocol-version": protocolVersion,
    ...headers,
  });
  response.end(data);
}

function parseProjectPath(pathname, decode, makeHttpError) {
  const match = /^\/v2\/projects\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) {
    return null;
  }
  let projectId;
  try {
    projectId = decode(match[1]);
  } catch {
    throw makeHttpError("INVALID_PROJECT_ID", "server http: project ID path segment is not valid URL encoding", undefined, 400);
  }
  return { projectId, route: match[2] || "" };
}

async function readJsonBody(request, makeHttpError) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
  if (!contentType.includes("application/json")) {
    throw makeHttpError("UNSUPPORTED_MEDIA_TYPE", "server http: Content-Type must be application/json", undefined, 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw makeHttpError("REQUEST_TOO_LARGE", `server http: request body exceeds ${MAX_BODY_BYTES} bytes`, undefined, 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw makeHttpError("INVALID_JSON", "server http: request body must be valid JSON", undefined, 400);
  }
}

const READ_ROUTES = [
  ["status", /^read\/status$/, ["initiative", "kind", "status", "domain", "claimed-by", "stale-ms", "limit", "all", "as"]],
  ["context", /^read\/context\/([^/]+)$/, ["as", "staleMs"]],
  ["show", /^read\/show\/([^/]+)$/, []],
  ["history", /^read\/history\/([^/]+)$/, ["limit"]],
  ["search", /^read\/search(?:\/([^/]+))?$/, ["query", "all"]],
  ["initiatives", /^read\/initiatives$/, ["all"]],
  ["log", /^read\/log$/, ["limit", "action", "agent", "task", "decision"]],
  ["state", /^read\/state$/, []],
  ["node", /^read\/nodes\/([^/]+)$/, []],
];

function readRoute(route, makeHttpError) {
  for (const [kind, pattern, allowedQuery] of READ_ROUTES) {
    const match = pattern.exec(route);
    if (!match) {
      continue;
    }
    if (match[1] === undefined) {
      return { kind, allowedQuery };
    }
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw makeHttpError("INVALID_REQUEST", "server http: node ID path segment is not valid URL encoding", { field: "id" }, 400);
    }
    if (kind === "search") {
      return { kind, id, query: id, allowedQuery };
    }
    return { kind, id, allowedQuery };
  }
  return null;
}

export function createHttpCodec({ protocolVersion }) {
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    throw new TypeError("server http codec: protocolVersion is required");
  }

  return {
    protocolVersion,
    httpError,
    errorStatus,
    jsonError,
    send: (response, status, body, headers = {}) => send(response, status, body, { headers, protocolVersion }),
    parseProjectPath: (pathname) => parseProjectPath(pathname, decodeURIComponent, httpError),
    readJsonBody: (request) => readJsonBody(request, httpError),
    readRoute: (route) => readRoute(route, httpError),
  };
}
