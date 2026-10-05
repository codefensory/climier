const CREDENTIAL_KEYS = new Set([
  "accesskey", "accesstoken", "apikey", "authorization", "auth", "clientsecret", "credential",
  "credentials", "password", "privatekey", "refreshtoken", "secret", "signingkey", "token",
]);

function fail(message, code, details) {
  const error = new Error(`backend config: ${message}`);
  if (code) {error.code = code;}
  if (details !== undefined) {error.details = details;}
  throw error;
}

function normalizeKey(key) {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function hasCredentialField(value, visited = new Set()) {
  if (value === null || typeof value !== "object" || visited.has(value)) {return false;}
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(normalizeKey(key)) || hasCredentialField(child, visited)) {return true;}
  }
  return false;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isValidRemoteUrl(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return fail("remote url must be an absolute HTTP(S) URL");
  }
}

function validateRemoteUrl(url) {
  if (url.protocol !== "https:" && url.protocol !== "http:") {fail("remote url must use HTTP or HTTPS");}
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    fail("credentials must be provided outside .climier.json");
  }
}

function parseRemoteUrl(value) {
  if (!isValidRemoteUrl(value)) {fail("remote url must be an absolute HTTP(S) URL");}
  const url = parseUrl(value);
  validateRemoteUrl(url);
  return { url: url.toString(), insecureRemoteHttp: url.protocol === "http:" && !isLoopback(url.hostname) };
}

function validateProjectConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {fail("project config must be an object");}
  if (hasCredentialField(config)) {fail("credentials must be provided outside .climier.json");}
}

function validateBackendShape(backend) {
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) {fail("backend must be an object");}
  if (Object.keys(backend).some((key) => !["type", "url", "protocol"].includes(key))) {
    fail("backend accepts only type, url and protocol");
  }
}

function parseLocalBackend(backend) {
  if (Object.hasOwn(backend, "url")) {fail("local backend does not accept a url");}
  return { type: "local" };
}

function isLinkCommandRelink(config, command) {
  return command === "link" && typeof config.project_id === "string" && config.project_id.trim();
}

function parseRemoteBackend(backend, config, command) {
  if (isLinkCommandRelink(config, command)) {return { type: "local" };}
  if (backend.protocol !== "v2") {
    fail("remote config must be relinked for protocol v2", "REMOTE_CONFIG_OUTDATED", { expected_protocol: "v2" });
  }
  if (!Object.hasOwn(backend, "url")) {fail("remote url is required");}
  const parsedUrl = parseRemoteUrl(backend.url);
  if (parsedUrl.insecureRemoteHttp && process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP !== "true") {
    fail("remote url must use HTTPS outside localhost");
  }
  const result = { type: "remote", url: parsedUrl.url, protocol: "v2" };
  if (parsedUrl.insecureRemoteHttp) {result.insecureRemoteHttp = true;}
  return result;
}

/** Parse backend selection from project metadata without exposing credentials. */
export function parseBackendConfig(config = {}, { command } = {}) {
  validateProjectConfig(config);
  if (!Object.hasOwn(config, "backend")) {return { type: "local" };}
  const backend = config.backend;
  validateBackendShape(backend);
  if (backend.type === "local") {return parseLocalBackend(backend);}
  if (backend.type !== "remote") {fail("unsupported type");}
  return parseRemoteBackend(backend, config, command);
}
