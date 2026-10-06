import type { BackendMetadata, BackendSelection, ProjectConfig, RemoteBackend } from "./types.ts";
import { isRecord } from "./types.ts";

const CREDENTIAL_KEYS = new Set([
  "accesskey", "accesstoken", "apikey", "authorization", "auth", "clientsecret", "credential",
  "credentials", "password", "privatekey", "refreshtoken", "secret", "signingkey", "token",
]);

function fail(message: string, code?: string, details?: Record<string, unknown>): never {
  const error = new Error(`backend config: ${message}`);
  if (code) {error.code = code;}
  if (details !== undefined) {error.details = details;}
  throw error;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function hasCredentialField(value: unknown, visited: Set<object> = new Set()): boolean {
  if (!isRecord(value) || visited.has(value)) {return false;}
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(normalizeKey(key)) || hasCredentialField(child, visited)) {return true;}
  }
  return false;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isValidRemoteUrl(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return fail("remote url must be an absolute HTTP(S) URL");
  }
}

function validateRemoteUrl(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {fail("remote url must use HTTP or HTTPS");}
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    fail("credentials must be provided outside .climier.json");
  }
}

function parseRemoteUrl(value: unknown): { url: string; insecureRemoteHttp: boolean } {
  if (!isValidRemoteUrl(value)) {fail("remote url must be an absolute HTTP(S) URL");}
  const url = parseUrl(value);
  validateRemoteUrl(url);
  return { url: url.toString(), insecureRemoteHttp: url.protocol === "http:" && !isLoopback(url.hostname) };
}

function validateProjectConfig(config: unknown): asserts config is ProjectConfig {
  if (!isRecord(config) || Array.isArray(config)) {fail("project config must be an object");}
  if (hasCredentialField(config)) {fail("credentials must be provided outside .climier.json");}
}

function outdatedRemoteConfig(backend: BackendMetadata): never {
  const configuredUrl = typeof backend.url === "string" ? backend.url : String(backend.url ?? "<missing>");
  const cleanupCommand = `climier link ${configuredUrl}`;
  fail(
    `remote metadata at backend.url ${configuredUrl} contains removed backend.protocol; run ${cleanupCommand} to clean .climier.json without contacting the remote`,
    "REMOTE_CONFIG_OUTDATED",
    { configured_url: configuredUrl, cleanup: cleanupCommand },
  );
}

function validateBackendShape(backend: unknown): asserts backend is BackendMetadata {
  if (!isRecord(backend) || Array.isArray(backend)) {fail("backend must be an object");}
  if (Object.hasOwn(backend, "protocol")) {outdatedRemoteConfig(backend);}
  if (Object.keys(backend).some((key) => !["type", "url"].includes(key))) {
    fail("backend accepts only type and url");
  }
}

function parseLocalBackend(backend: BackendMetadata): { type: "local" } {
  if (Object.hasOwn(backend, "url")) {fail("local backend does not accept a url");}
  return { type: "local" };
}

function parseRemoteBackend(backend: BackendMetadata): RemoteBackend {
  if (!Object.hasOwn(backend, "url")) {fail("remote url is required");}
  const parsedUrl = parseRemoteUrl(backend.url);
  const result: RemoteBackend = { type: "remote", url: parsedUrl.url };
  if (parsedUrl.insecureRemoteHttp) {result.insecureRemoteHttp = true;}
  return result;
}

/** Parse backend selection from project metadata without exposing credentials. */
export function parseBackendConfig(config: ProjectConfig = {}, _options: { command?: string } = {}): BackendSelection {
  validateProjectConfig(config);
  if (!Object.hasOwn(config, "backend")) {return { type: "local" };}
  const backend = config.backend;
  validateBackendShape(backend);
  if (backend.type === "local") {return parseLocalBackend(backend);}
  if (backend.type !== "remote") {fail("unsupported type");}
  return parseRemoteBackend(backend);
}
