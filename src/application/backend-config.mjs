const CREDENTIAL_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "auth",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "signingkey",
  "token",
]);

function fail(message) {
  throw new Error(`backend config: ${message}`);
}

function normalizeKey(key) {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function hasCredentialField(value, visited = new Set()) {
  if (value === null || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(normalizeKey(key)) || hasCredentialField(child, visited)) return true;
  }

  return false;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseRemoteUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail("remote url must be an absolute HTTP(S) URL");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    fail("remote url must be an absolute HTTP(S) URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("remote url must use HTTP or HTTPS");
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    fail("credentials must be provided outside .climier.json");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    fail("remote url must use HTTPS outside localhost");
  }

  return url.toString();
}

/** Parse backend selection from project metadata without exposing credentials. */
export function parseBackendConfig(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("project config must be an object");
  }
  if (hasCredentialField(config)) {
    fail("credentials must be provided outside .climier.json");
  }
  if (!Object.hasOwn(config, "backend")) return { type: "local" };

  const backend = config.backend;
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) {
    fail("backend must be an object");
  }
  if (Object.keys(backend).some((key) => !["type", "url"].includes(key))) {
    fail("backend accepts only type and url");
  }

  if (backend.type === "local") {
    if (Object.hasOwn(backend, "url")) fail("local backend does not accept a url");
    return { type: "local" };
  }
  if (backend.type !== "remote") fail("unsupported type");
  if (!Object.hasOwn(backend, "url")) fail("remote url is required");

  return { type: "remote", url: parseRemoteUrl(backend.url) };
}
