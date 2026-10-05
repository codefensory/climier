import { AUTH_STORAGE_KEY, PROTOCOL_HEADER, PROTOCOL_VERSION, type ApiErrorBody, type ProjectSummary, type SnapshotResponse } from "./protocol";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status: number, code = "HTTP_ERROR", details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type HttpClientOptions = {
  baseUrl?: string;
  fetch?: FetchLike;
  storage?: StorageLike | null;
  getToken?: () => string | null;
  onUnauthorized?: () => void;
};

type RequestOptions = RequestInit & { auth?: boolean };

type LoginResult = {
  token: string;
  token_type?: string;
  expires_in_days?: number;
};

function browserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function errorFromBody(body: ApiErrorBody | null, status: number): HttpError {
  const raw = body?.error;
  if (typeof raw === "string") return new HttpError(raw, status, "HTTP_ERROR");
  return new HttpError(raw?.message ?? `Request failed with status ${status}`, status, raw?.code ?? "HTTP_ERROR", raw?.details);
}

export function createHttpClient(options: HttpClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  let token = options.getToken?.() ?? storage?.getItem(AUTH_STORAGE_KEY) ?? null;

  const setToken = (value: string | null) => {
    token = value;
  };

  const requestRaw = async (path: string, request: RequestOptions = {}): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION);
    if (request.auth !== false && token) headers.set("Authorization", `Bearer ${token}`);
    if (request.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const { auth: _auth, ...init } = request;
    const response = await fetcher(new URL(path, baseUrl || window.location.origin), { ...init, headers });
    if (response.status === 401 && request.auth !== false) options.onUnauthorized?.();
    return response;
  };

  const requestJson = async <T>(path: string, request: RequestOptions = {}): Promise<T> => {
    const response = await requestRaw(path, request);
    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      try { body = await response.json() as ApiErrorBody; } catch { /* The status still describes the failure. */ }
      throw errorFromBody(body, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };

  const login = async (password: string): Promise<LoginResult> => {
    const payload = await requestJson<{ ok: boolean; token: string; token_type?: string; expires_in_days?: number }>("/v1/auth/login", {
      method: "POST",
      auth: false,
      body: JSON.stringify({ password }),
    });
    if (!payload.token) throw new HttpError("Login response did not include a token", 502, "INVALID_LOGIN_RESPONSE");
    setToken(payload.token);
    return payload;
  };

  const getProjects = async (): Promise<ProjectSummary[]> => {
    const payload = await requestJson<{ projects?: ProjectSummary[] }>("/v1/projects", { method: "GET" });
    return Array.isArray(payload.projects) ? payload.projects : [];
  };

  const getSnapshot = async <T>(projectId: string, etag?: string | null): Promise<SnapshotResponse<T>> => {
    const headers = new Headers({ Accept: "application/json" });
    if (etag) headers.set("If-None-Match", etag);
    const response = await requestRaw(`/v1/projects/${encodeURIComponent(projectId)}/ui/snapshot`, { method: "GET", headers });
    const responseEtag = response.headers.get("ETag");
    if (response.status === 304) return { status: 304, snapshot: null, etag: responseEtag ?? etag ?? null };
    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      try { body = await response.json() as ApiErrorBody; } catch { /* The status still describes the failure. */ }
      throw errorFromBody(body, response.status);
    }
    const payload = await response.json() as { result?: T };
    return { status: 200, snapshot: payload.result ?? null, etag: responseEtag };
  };

  const openEvents = async (projectId: string, signal?: AbortSignal): Promise<Response> => {
    const response = await requestRaw(`/v1/projects/${encodeURIComponent(projectId)}/ui/events`, {
      method: "GET",
      signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      try { body = await response.json() as ApiErrorBody; } catch { /* The status still describes the failure. */ }
      throw errorFromBody(body, response.status);
    }
    return response;
  };

  return Object.freeze({
    login,
    getProjects,
    getSnapshot,
    openEvents,
    requestJson,
    setToken,
    getToken: () => options.getToken?.() ?? token,
    clearToken: () => setToken(null),
  });
}
