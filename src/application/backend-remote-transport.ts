import type { CodedApplicationError, RemoteRequest } from "./types.ts";
import { isRecord } from "./types.ts";

export const REMOTE_PROTOCOL_VERSION = "1";

type RequestBody = { method: string; route: string; body?: unknown };

type RequestOptionsInput = {
  method: string;
  body?: unknown;
  token: string | null | undefined;
  signal: AbortSignal;
};

function clientError(code: string, message: string, details?: Record<string, unknown>): CodedApplicationError {
  const error = new Error(message) as CodedApplicationError;
  error.code = code;
  if (details !== undefined) {error.details = details;}
  return error;
}

function remoteUrl({ baseUrl, projectId, route }: { baseUrl: string; projectId: string; route: string }): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/v1/projects/${encodeURIComponent(projectId)}/${route}`;
}

function requestOptions({ method, body, token, signal }: RequestOptionsInput): RequestInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-climier-protocol-version": REMOTE_PROTOCOL_VERSION,
  };
  if (token) {headers.authorization = `Bearer ${token}`;}
  const options: RequestInit = { method, headers, signal };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return options;
}

function timeoutError(timeoutMs: number): CodedApplicationError {
  return clientError(
    "REMOTE_TIMEOUT",
    `application.backendClient: remote request timed out after ${timeoutMs}ms`,
    { timeout_ms: timeoutMs },
  );
}

async function fetchResponse(url: string, options: RequestInit, controller: AbortController, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (cause: unknown) {
    if (controller.signal.aborted) {throw timeoutError(timeoutMs);}
    const message = cause instanceof Error ? cause.message : String(cause);
    const error = clientError(
      "REMOTE_REQUEST_FAILED",
      `application.backendClient: remote request failed: ${message}`,
    );
    error.cause = cause;
    throw error;
  }
}

async function parseResponse(response: Response, controller: AbortController, timeoutMs: number): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause: unknown) {
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

function remoteError(body: unknown, status: number): CodedApplicationError {
  const payload = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : null;
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
    payload.details as Record<string, unknown> | undefined,
  );
  error.status = status;
  return error;
}

function validateHttpResponse(response: Response, envelope: unknown): void {
  if (!response.ok || (isRecord(envelope) && envelope.ok === false)) {throw remoteError(envelope, response.status);}
}

function validateProtocolVersion(response: Response, { transferImport = false } = {}): void {
  const received = response.headers.get("x-climier-protocol-version");
  if (received === REMOTE_PROTOCOL_VERSION) {return;}
  if (transferImport && response.status === 200 && received === null
      && response.headers.get("content-length") === null) {
    throw clientError(
      "REMOTE_REQUEST_FAILED",
      "application.backendClient: remote transfer import response was dropped before completion",
    );
  }
  const label = received === null ? "missing" : received;
  throw clientError(
    "PROTOCOL_VERSION_UNSUPPORTED",
    `application.backendClient: remote protocol version '${label}' is not supported; expected '${REMOTE_PROTOCOL_VERSION}'`,
    { expected: REMOTE_PROTOCOL_VERSION, received },
  );
}

function responseResult(response: Response, envelope: unknown): unknown {
  validateProtocolVersion(response);
  validateHttpResponse(response, envelope);
  if (!isRecord(envelope) || envelope.ok !== true || !Object.hasOwn(envelope, "result")) {
    throw clientError(
      "REMOTE_INVALID_RESPONSE",
      "application.backendClient: remote response must contain an { ok: true, result } envelope",
      { status: response.status },
    );
  }
  return envelope.result;
}

function validateResponse(response: Response, envelope: unknown): unknown {
  return responseResult(response, envelope);
}

export function createRemoteRequest({
  backend,
  projectId,
  tokenProvider,
  timeoutMs,
}: {
  backend: { url: string };
  projectId: string;
  tokenProvider: (origin: string) => Promise<string | null>;
  timeoutMs: number;
}): RemoteRequest {
  return async function request({ method, route, body }: RequestBody): Promise<unknown> {
    const url = remoteUrl({ baseUrl: backend.url, projectId, route });
    const token = await tokenProvider(new URL(backend.url).origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = requestOptions({ method, body, token, signal: controller.signal });
      const response = await fetchResponse(url, options, controller, timeoutMs);
      validateProtocolVersion(response, { transferImport: method === "POST" && route === "transfer/import" });
      const envelope = await parseResponse(response, controller, timeoutMs);
      return validateResponse(response, envelope);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function loginRemote({ origin, password, timeoutMs = 10_000 }: {
  origin: string;
  password: string;
  timeoutMs?: number;
}): Promise<{ token: string; expires_in_days: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${origin.replace(/\/+$/, "")}/v1/auth/login`;
    const options = requestOptions({ method: "POST", body: { password }, token: null, signal: controller.signal });
    const response = await fetchResponse(url, options, controller, timeoutMs);
    validateProtocolVersion(response);
    const envelope = await parseResponse(response, controller, timeoutMs);
    validateHttpResponse(response, envelope);
    if (!isRecord(envelope) || typeof envelope.token !== "string" || !envelope.token) {
      throw clientError("REMOTE_INVALID_RESPONSE", "application.backendClient: login response did not contain a bearer token", { status: response.status });
    }
    return { token: envelope.token, expires_in_days: envelope.expires_in_days };
  } finally {
    clearTimeout(timeout);
  }
}
