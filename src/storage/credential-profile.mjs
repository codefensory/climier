import fs from "node:fs/promises";
import path from "node:path";

import { climierHome } from "./paths.mjs";

const PROFILE_FILE = "remote-sessions.json";

function emptyProfile() {
  return { version: 1, sessions: {} };
}

function profileError(message, cause) {
  const error = new Error(`credential store: ${message}`);
  error.code = "CREDENTIAL_PROFILE_ERROR";
  if (cause) {error.cause = cause;}
  return error;
}

function isLoopbackHost(host) {
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function hasAllowedProtocol(url) {
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
}

function permitsHttpOrigin(url, allowInsecureRemoteHttp) {
  return url.protocol !== "http:" || isLoopbackHost(url.hostname.toLowerCase()) || allowInsecureRemoteHttp;
}

function normalizeOrigin(value, { allowInsecureRemoteHttp = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP === "true" } = {}) {
  let url;
  try { url = new URL(value); } catch (cause) { throw profileError("origin must be an absolute HTTP(S) URL", cause); }
  if (!hasAllowedProtocol(url)) {
    throw profileError("origin must be an absolute HTTP(S) URL without credentials");
  }
  if (!permitsHttpOrigin(url, allowInsecureRemoteHttp)) {
    throw profileError("origin must use HTTPS outside localhost");
  }
  return url.origin;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasValidSession(origin, session) {
  return normalizeOrigin(origin, { allowInsecureRemoteHttp: true }) === origin
    && isRecord(session) && typeof session.token === "string" && session.token.length > 0;
}

function hasValidProfileShape(value) {
  return isRecord(value) && value.version === 1 && isRecord(value.sessions);
}

function validateProfile(value) {
  if (!hasValidProfileShape(value)) {throw profileError("profile is corrupt");}
  for (const [origin, session] of Object.entries(value.sessions)) {
    if (!hasValidSession(origin, session)) {throw profileError("profile is corrupt");}
  }
  return value;
}

async function readProfileFile(file) {
  let raw;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") {return emptyProfile();}
    throw profileError(`cannot read ${file}: ${error.message}`, error);
  }
  try { return validateProfile(JSON.parse(raw)); }
  catch (error) {
    if (error.code === "CREDENTIAL_PROFILE_ERROR") {throw error;}
    throw profileError(`profile at ${file} is corrupt`, error);
  }
}

async function writeProfileFile(directory, file, profile) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(profile, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw profileError(`cannot persist ${file}: ${error.message}`, error);
  }
}

export function createCredentialStore({ home = climierHome() } = {}) {
  const directory = path.resolve(home);
  const file = path.join(directory, PROFILE_FILE);
  return Object.freeze({
    file,
    async get(origin) {
      const profile = await readProfileFile(file);
      return profile.sessions[normalizeOrigin(origin)]?.token ?? null;
    },
    async set(origin, token) {
      if (typeof token !== "string" || !token) {throw profileError("bearer token must be a non-empty string");}
      const key = normalizeOrigin(origin);
      const profile = await readProfileFile(file);
      profile.sessions[key] = { token };
      await writeProfileFile(directory, file, profile);
    },
    async delete(origin) {
      const key = normalizeOrigin(origin);
      const profile = await readProfileFile(file);
      if (!Object.hasOwn(profile.sessions, key)) {return false;}
      delete profile.sessions[key];
      await writeProfileFile(directory, file, profile);
      return true;
    },
  });
}

export { normalizeOrigin };
