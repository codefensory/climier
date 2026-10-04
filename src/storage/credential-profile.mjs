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

function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch (cause) { throw profileError("origin must be an absolute HTTP(S) URL", cause); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw profileError("origin must be an absolute HTTP(S) URL without credentials");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol === "http:" && !loopback) {
    throw profileError("origin must use HTTPS outside localhost");
  }
  return url.origin;
}

function validateProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)) {
    throw profileError("profile is corrupt");
  }
  for (const [origin, session] of Object.entries(value.sessions)) {
    if (normalizeOrigin(origin) !== origin || !session || typeof session.token !== "string" || !session.token) {
      throw profileError("profile is corrupt");
    }
  }
  return value;
}

export function createCredentialStore({ home = climierHome() } = {}) {
  const directory = path.resolve(home);
  const file = path.join(directory, PROFILE_FILE);

  async function readProfile() {
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

  async function writeProfile(profile) {
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

  return Object.freeze({
    file,
    async get(origin) {
      const profile = await readProfile();
      return profile.sessions[normalizeOrigin(origin)]?.token ?? null;
    },
    async set(origin, token) {
      if (typeof token !== "string" || !token) {throw profileError("bearer token must be a non-empty string");}
      const key = normalizeOrigin(origin);
      const profile = await readProfile();
      profile.sessions[key] = { token };
      await writeProfile(profile);
    },
    async delete(origin) {
      const key = normalizeOrigin(origin);
      const profile = await readProfile();
      if (!Object.hasOwn(profile.sessions, key)) {return false;}
      delete profile.sessions[key];
      await writeProfile(profile);
      return true;
    },
  });
}

export { normalizeOrigin };
