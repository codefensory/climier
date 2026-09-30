export const REMOTE_PROTOCOL_VERSION = "2";

function clientError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function remoteUrl({ baseUrl, projectId, route }) {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/v2/projects/${encodeURIComponent(projectId)}/${route}`;
}

function requestOptions({ method, body, token, signal }) {
  const headers = {
    accept: "application/json",
    "x-climier-protocol-version": REMOTE_PROTOCOL_VERSION,
  };
  if (token) {headers.authorization = `Bearer ${token}`;}
  const options = { method, headers, signal };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return options;
}

function timeoutError(timeoutMs) {
  return clientError(
    "REMOTE_TIMEOUT",
    `application.backendClient: remote request timed out after ${timeoutMs}ms`,
    { timeout_ms: timeoutMs },
  );
}

async function fetchResponse(url, options, controller, timeoutMs) {
  try {
    return await fetch(url, options);
  } catch (cause) {
    if (controller.signal.aborted) {throw timeoutError(timeoutMs);}
    const error = clientError(
      "REMOTE_REQUEST_FAILED",
      `application.backendClient: remote request failed: ${cause.message}`,
    );
    error.cause = cause;
    throw error;
  }
}

async function parseResponse(response, controller, timeoutMs) {
  try {
    return await response.json();
  } catch (cause) {
    if (controller.signal.aborted) {throw timeoutError(timeoutMs);}
    const error = clientError(
      "REMOTE_INVALID_RESPONSE",
      "application.backendClient: remote response was not valid JSON",
      { status: response.status },
    );
    error.cause = cause;
    throw error;
  }
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

function validateHttpResponse(response, envelope) {
  if (!response.ok || (envelope && envelope.ok === false)) {throw remoteError(envelope, response.status);}
}

function validateProtocolVersion(response) {
  const received = response.headers.get("x-climier-protocol-version");
  if (received === REMOTE_PROTOCOL_VERSION) {return;}
  const label = received === null ? "missing" : received;
  throw clientError(
    "PROTOCOL_VERSION_UNSUPPORTED",
    `application.backendClient: remote protocol version '${label}' is not supported; expected '${REMOTE_PROTOCOL_VERSION}'`,
    { expected: REMOTE_PROTOCOL_VERSION, received },
  );
}

function responseResult(response, envelope) {
  validateHttpResponse(response, envelope);
  validateProtocolVersion(response);
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true || !Object.hasOwn(envelope, "result")) {
    throw clientError(
      "REMOTE_INVALID_RESPONSE",
      "application.backendClient: remote response must contain an { ok: true, result } envelope",
      { status: response.status },
    );
  }
  return envelope.result;
}

function validateResponse(response, envelope) {
  return responseResult(response, envelope);
}

export function createRemoteRequest({ backend, projectId, tokenProvider, timeoutMs }) {
  return async function request({ method, route, body }) {
    const url = remoteUrl({ baseUrl: backend.url, projectId, route });
    const token = await tokenProvider(new URL(backend.url).origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = requestOptions({ method, body, token, signal: controller.signal });
      const response = await fetchResponse(url, options, controller, timeoutMs);
      const envelope = await parseResponse(response, controller, timeoutMs);
      return validateResponse(response, envelope);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function loginRemote({ origin, password, timeoutMs = 10_000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${origin.replace(/\/+$/, "")}/v2/auth/login`;
    const options = requestOptions({ method: "POST", body: { password }, token: null, signal: controller.signal });
    const response = await fetchResponse(url, options, controller, timeoutMs);
    const envelope = await parseResponse(response, controller, timeoutMs);
    validateHttpResponse(response, envelope);
    validateProtocolVersion(response);
    if (!envelope || typeof envelope.token !== "string" || !envelope.token) {
      throw clientError("REMOTE_INVALID_RESPONSE", "application.backendClient: login response did not contain a bearer token", { status: response.status });
    }
    return { token: envelope.token, expires_in_days: envelope.expires_in_days };
  } finally {
    clearTimeout(timeout);
  }
}
