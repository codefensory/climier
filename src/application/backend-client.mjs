import { parseBackendConfig } from "./backend-config.mjs";
import { executeBatch, executeOperation } from "./operations/execute.mjs";

export const REMOTE_PROTOCOL_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 10_000;

function clientError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function remoteUrl({ baseUrl, projectId, route }) {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/v1/projects/${encodeURIComponent(projectId)}/${route}`;
}

function remoteError(body, status) {
  const payload = body && body.ok === false && body.error && typeof body.error === "object"
    ? body.error
    : null;
  if (!payload) {
    return clientError(
      "REMOTE_HTTP_ERROR",
      `application.backendClient: remote request failed with HTTP ${status}`,
      { status },
    );
  }
  const error = clientError(
    typeof payload.code === "string" ? payload.code : "REMOTE_HTTP_ERROR",
    typeof payload.message === "string" ? payload.message : `application.backendClient: remote request failed with HTTP ${status}`,
    payload.details,
  );
  error.status = status;
  return error;
}

function remoteProtocolError(received) {
  return clientError(
    "PROTOCOL_VERSION_UNSUPPORTED",
    `application.backendClient: remote protocol version '${received === null ? "missing" : received}' is not supported; expected '${REMOTE_PROTOCOL_VERSION}'`,
    { expected: REMOTE_PROTOCOL_VERSION, received },
  );
}

function invalidReadRequest(method, message, field) {
  return clientError(
    "INVALID_REQUEST",
    `application.backendClient: ${method} ${message}`,
    field ? { field } : undefined,
  );
}

function readOptions(method, options, allowed) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw invalidReadRequest(method, "options must be an object", "options");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw invalidReadRequest(method, `option '${key}' is not supported`, key);
  }
  return options;
}

function validateReadOptions(method, options, types) {
  for (const [name, type] of Object.entries(types)) {
    const value = options[name];
    if (value === undefined || (value === null && type.nullable)) continue;
    const valid = type.kind === "string"
      ? typeof value === "string"
      : type.kind === "boolean"
        ? typeof value === "boolean"
        : type.kind === "non-negative-integer"
          ? Number.isSafeInteger(value) && value >= 0
          : type.kind === "non-negative-number"
            ? typeof value === "number" && Number.isFinite(value) && value >= 0
            : false;
    if (!valid) throw invalidReadRequest(method, `option '${name}' has an invalid value`, name);
  }
}

function readId(method, options) {
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw invalidReadRequest(method, "node id is required", "id");
  }
  return options.id;
}

function readQuery(options, mapping) {
  const query = new URLSearchParams();
  for (const [option, parameter] of mapping) {
    const value = options[option];
    if (value === undefined || value === null) continue;
    query.set(parameter, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function createRemoteTransport({ backend, projectId, token, timeoutMs }) {
  async function request({ method, route, body }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      accept: "application/json",
      "x-climier-protocol-version": REMOTE_PROTOCOL_VERSION,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const options = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    try {
      let response;
      try {
        response = await fetch(remoteUrl({ baseUrl: backend.url, projectId, route }), options);
      } catch (cause) {
        if (controller.signal.aborted) {
          throw clientError(
            "REMOTE_TIMEOUT",
            `application.backendClient: remote request timed out after ${timeoutMs}ms`,
            { timeout_ms: timeoutMs },
          );
        }
        const error = clientError(
          "REMOTE_REQUEST_FAILED",
          `application.backendClient: remote request failed: ${cause.message}`,
        );
        error.cause = cause;
        throw error;
      }

      let envelope;
      try {
        envelope = await response.json();
      } catch (cause) {
        if (controller.signal.aborted) {
          throw clientError(
            "REMOTE_TIMEOUT",
            `application.backendClient: remote request timed out after ${timeoutMs}ms`,
            { timeout_ms: timeoutMs },
          );
        }
        const error = clientError(
          "REMOTE_INVALID_RESPONSE",
          "application.backendClient: remote response was not valid JSON",
          { status: response.status },
        );
        error.cause = cause;
        throw error;
      }

      if (!response.ok || (envelope && envelope.ok === false)) {
        throw remoteError(envelope, response.status);
      }
      if (response.headers.get("x-climier-protocol-version") !== REMOTE_PROTOCOL_VERSION) {
        throw remoteProtocolError(response.headers.get("x-climier-protocol-version"));
      }
      if (!envelope || typeof envelope !== "object" || envelope.ok !== true || !Object.hasOwn(envelope, "result")) {
        throw clientError(
          "REMOTE_INVALID_RESPONSE",
          "application.backendClient: remote response must contain an { ok: true, result } envelope",
          { status: response.status },
        );
      }
      return envelope.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({
    executeOperation({ actor, operation, input } = {}) {
      return request({
        method: "POST",
        route: "operations",
        body: { operation, actor, input },
      });
    },
    executeBatch({ actor, operations, if_state_revision } = {}) {
      const input = { operations };
      if (if_state_revision !== undefined) input.if_state_revision = if_state_revision;
      return request({
        method: "POST",
        route: "operations",
        body: { operation: "core.batch", actor, input },
      });
    },
    readStatus(options = {}) {
      const method = "readStatus";
      readOptions(method, options, ["initiative", "kind", "status", "domain", "claimedBy", "staleMs", "limit", "all", "as"]);
      validateReadOptions(method, options, {
        initiative: { kind: "string" },
        kind: { kind: "string" },
        status: { kind: "string" },
        domain: { kind: "string" },
        claimedBy: { kind: "string" },
        staleMs: { kind: "non-negative-integer" },
        limit: { kind: "non-negative-integer" },
        all: { kind: "boolean" },
        as: { kind: "string" },
      });
      return request({
        method: "GET",
        route: `read/status${readQuery(options, [
          ["initiative", "initiative"],
          ["kind", "kind"],
          ["status", "status"],
          ["domain", "domain"],
          ["claimedBy", "claimed-by"],
          ["staleMs", "stale-ms"],
          ["limit", "limit"],
          ["all", "all"],
          ["as", "as"],
        ])}`,
      });
    },
    readContext(options = {}) {
      const method = "readContext";
      readOptions(method, options, ["id", "as", "staleMs"]);
      const id = readId(method, options);
      validateReadOptions(method, options, {
        as: { kind: "string" },
        staleMs: { kind: "non-negative-number" },
      });
      return request({
        method: "GET",
        route: `read/context/${encodeURIComponent(id)}${readQuery(options, [["as", "as"], ["staleMs", "staleMs"]])}`,
      });
    },
    readNode(options = {}) {
      const method = "readNode";
      readOptions(method, options, ["id"]);
      const id = readId(method, options);
      return request({ method: "GET", route: `read/show/${encodeURIComponent(id)}` });
    },
    readHistory(options = {}) {
      const method = "readHistory";
      readOptions(method, options, ["id", "limit"]);
      const id = readId(method, options);
      validateReadOptions(method, options, { limit: { kind: "non-negative-integer" } });
      return request({
        method: "GET",
        route: `read/history/${encodeURIComponent(id)}${readQuery(options, [["limit", "limit"]])}`,
      });
    },
    readSearch(options = {}) {
      const method = "readSearch";
      readOptions(method, options, ["query", "all"]);
      validateReadOptions(method, options, {
        query: { kind: "string" },
        all: { kind: "boolean" },
      });
      return request({
        method: "GET",
        route: `read/search${readQuery(options, [["query", "query"], ["all", "all"]])}`,
      });
    },
    readInitiatives(options = {}) {
      const method = "readInitiatives";
      readOptions(method, options, ["all"]);
      validateReadOptions(method, options, { all: { kind: "boolean" } });
      return request({ method: "GET", route: `read/initiatives${readQuery(options, [["all", "all"]])}` });
    },
    readLog(options = {}) {
      const method = "readLog";
      readOptions(method, options, ["limit", "action", "agent", "task", "decision"]);
      validateReadOptions(method, options, {
        limit: { kind: "non-negative-integer" },
        action: { kind: "string" },
        agent: { kind: "string" },
        task: { kind: "string" },
        decision: { kind: "string" },
      });
      return request({
        method: "GET",
        route: `read/log${readQuery(options, [
          ["limit", "limit"],
          ["action", "action"],
          ["agent", "agent"],
          ["task", "task"],
          ["decision", "decision"],
        ])}`,
      });
    },
    readState() {
      return request({ method: "GET", route: "read/state" });
    },
  });
}

/** Create one backend selection for a project; remote failures never retry locally. */
export function createBackendClient({
  projectDir,
  projectConfig = {},
  source,
  token = process.env.CLIMIER_TOKEN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw clientError("INVALID_BACKEND_CLIENT", "application.backendClient: projectDir is required", { field: "projectDir" });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw clientError("INVALID_BACKEND_CLIENT", "application.backendClient: timeoutMs must be a positive integer", { field: "timeoutMs" });
  }
  const backend = parseBackendConfig(projectConfig);
  if (backend.type === "local") {
    return Object.freeze({
      type: "local",
      executeOperation({ actor, operation, input } = {}) {
        return executeOperation({ projectDir, actor, operation, input, source });
      },
      executeBatch({ actor, operations, input, if_state_revision } = {}) {
        return executeBatch({ projectDir, actor, operations, input, if_state_revision, source });
      },
    });
  }
  if (typeof projectConfig.project_id !== "string" || projectConfig.project_id.length === 0) {
    throw clientError("REMOTE_PROJECT_ID_REQUIRED", "application.backendClient: remote backend requires project_id", { field: "project_id" });
  }
  if (token !== undefined && typeof token !== "string") {
    throw clientError("INVALID_BACKEND_CLIENT", "application.backendClient: token must be a string", { field: "token" });
  }
  const transport = createRemoteTransport({
    backend,
    projectId: projectConfig.project_id,
    token: token || null,
    timeoutMs,
  });
  return Object.freeze({ type: "remote", ...transport });
}

export default createBackendClient;
