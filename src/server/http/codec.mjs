const MAX_BODY_BYTES = 1024 * 1024;

export function createHttpCodec({ protocolVersion }) {
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    throw new TypeError("server http codec: protocolVersion is required");
  }

  function httpError(code, message, details, status) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    error.status = status;
    return error;
  }

  function errorStatus(error) {
    if (Number.isInteger(error && error.status)) return error.status;
    const code = error && error.code;
    if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return 401;
    if (code === "PROJECT_SCOPE_DENIED" || code === "POLICY_DENIED") return 403;
    if (code === "UNKNOWN_PROJECT") return 404;
    if (code === "OPERATION_NOT_FOUND") return 404;
    if (code === "INVALID_PROJECT_ID") return 400;
    if (code === "NODE_NOT_FOUND" || code === "INITIATIVE_NOT_FOUND") return 404;
    if (code === "ID_CONFLICT" || code === "REVISION_CONFLICT" || code === "STATE_REVISION_CONFLICT" || code === "STATE_ALREADY_INITIALIZED" || code === "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE" || code === "CLIMIER_TRANSFER_PLUGIN_DATA") return 409;
    if (code === "INVALID_NAME" || code === "MISSING_FIELD" || code === "INVALID_EDGE_TARGET" || code === "INVALID_EDGE_KIND" || code === "SELF_EDGE" || code === "DUPLICATE_EDGE" || code === "NOT_READY" || code === "INVALID_STATUS") return 422;
    if (code === "CLIMIER_INCOMPATIBLE_VERSION" || code === "STATE_V1_UNSUPPORTED") return 409;
    if (typeof code === "string" && (code.startsWith("MISSING_") || code.startsWith("INVALID_") || code.startsWith("SELF_") || code.startsWith("DUPLICATE_") || code.startsWith("NOT_READY"))) return 422;
    return 400;
  }

  function jsonError(error) {
    const code = error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    const message = error && typeof error.message === "string" ? error.message : "server http: request failed";
    const body = { ok: false, error: { code, message } };
    if (error && error.details !== undefined) body.error.details = error.details;
    return body;
  }

  function send(response, status, body, headers = {}) {
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

  function parseProjectPath(pathname) {
    const match = /^\/v1\/projects\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (!match) return null;
    let projectId;
    try {
      projectId = decodeURIComponent(match[1]);
    } catch {
      throw httpError("INVALID_PROJECT_ID", "server http: project ID path segment is not valid URL encoding", undefined, 400);
    }
    return { projectId, route: match[2] || "" };
  }

  async function readJsonBody(request) {
    if (!String(request.headers["content-type"] || "").toLowerCase().split(";")[0].trim().includes("application/json")) {
      throw httpError("UNSUPPORTED_MEDIA_TYPE", "server http: Content-Type must be application/json", undefined, 415);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        throw httpError("REQUEST_TOO_LARGE", `server http: request body exceeds ${MAX_BODY_BYTES} bytes`, undefined, 413);
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw httpError("INVALID_JSON", "server http: request body must be valid JSON", undefined, 400);
    }
  }

  function readRoute(route) {
    const definitions = [
      ["status", /^read\/status$/, "status", ["initiative", "kind", "status", "domain", "claimed-by", "stale-ms", "limit", "all", "as"]],
      ["context", /^read\/context\/([^/]+)$/, "context", ["as", "staleMs"]],
      ["show", /^read\/show\/([^/]+)$/, "show", []],
      ["history", /^read\/history\/([^/]+)$/, "history", ["limit"]],
      ["search", /^read\/search(?:\/([^/]+))?$/, "search", ["query", "all"]],
      ["initiatives", /^read\/initiatives$/, "initiatives", ["all"]],
      ["log", /^read\/log$/, "log", ["limit", "action", "agent", "task", "decision"]],
      ["state", /^read\/state$/, "state", []],
      ["node", /^read\/nodes\/([^/]+)$/, "node", []],
    ];
    for (const [, pattern, kind, allowedQuery] of definitions) {
      const match = pattern.exec(route);
      if (!match) continue;
      if (match[1] === undefined) return { kind, allowedQuery };
      let id;
      try {
        id = decodeURIComponent(match[1]);
      } catch {
        throw httpError("INVALID_REQUEST", "server http: node ID path segment is not valid URL encoding", { field: "id" }, 400);
      }
      if (kind === "search") return { kind, id, query: id, allowedQuery };
      return { kind, id, allowedQuery };
    }
    return null;
  }

  return {
    protocolVersion,
    httpError,
    errorStatus,
    jsonError,
    send,
    parseProjectPath,
    readJsonBody,
    readRoute,
  };
}
