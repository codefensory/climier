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
    readStatus() {
      return request({ method: "GET", route: "read/status" });
    },
    readNode({ id } = {}) {
      if (typeof id !== "string" || id.length === 0) {
        throw clientError("INVALID_REQUEST", "application.backendClient: node id is required", { field: "id" });
      }
      return request({ method: "GET", route: `read/nodes/${encodeURIComponent(id)}` });
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
