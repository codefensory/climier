import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const CONFIG_FIELDS = new Set(["listen", "dataRoot", "stateHome", "projectIds", "credentials"]);
const LISTEN_FIELDS = new Set(["host", "port"]);
const CREDENTIAL_FIELDS = new Set(["token", "projectIds"]);

function invalid(message, cause) {
  return Object.assign(new Error(`server config: ${message}`, cause ? { cause } : undefined), {
    code: "INVALID_SERVER_CONFIG",
  });
}

function hasOnlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function validProjectId(projectId) {
  return typeof projectId === "string" && projectId.length > 0
    && Buffer.byteLength(projectId, "utf8") <= 256
    && !/[\u0000-\u001f\u007f]/u.test(projectId);
}

function validateConfig(config) {
  if (!hasOnlyKeys(config, CONFIG_FIELDS)
      || !hasOnlyKeys(config.listen, LISTEN_FIELDS)
      || typeof config.listen.host !== "string" || config.listen.host.length === 0
      || !Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65_535) {
    throw invalid("expected only listen { host, port }, dataRoot, stateHome, projectIds, and credentials");
  }
  for (const key of ["dataRoot", "stateHome"]) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) {
      throw invalid(`${key} must be an absolute path`);
    }
  }
  if (!Array.isArray(config.projectIds) || config.projectIds.length === 0
      || config.projectIds.some((id) => !validProjectId(id))
      || new Set(config.projectIds).size !== config.projectIds.length) {
    throw invalid("projectIds must be a non-empty list of unique bounded opaque IDs");
  }
  if (!Array.isArray(config.credentials) || config.credentials.length === 0) {
    throw invalid("credentials must be a non-empty list");
  }
  const tokens = new Set();
  for (const credential of config.credentials) {
    if (!hasOnlyKeys(credential, CREDENTIAL_FIELDS)
        || typeof credential.token !== "string" || credential.token.length === 0
        || Buffer.byteLength(credential.token, "utf8") > 4096 || /\s/u.test(credential.token)
        || tokens.has(credential.token)) {
      throw invalid("credentials require unique non-empty bearer tokens and scoped projectIds");
    }
    tokens.add(credential.token);
    if (!Array.isArray(credential.projectIds) || credential.projectIds.length === 0
        || credential.projectIds.some((id) => !config.projectIds.includes(id))
        || new Set(credential.projectIds).size !== credential.projectIds.length) {
      throw invalid("credential projectIds must be a non-empty unique subset of configured projects");
    }
  }
  return Object.freeze({
    listen: Object.freeze({ ...config.listen }),
    dataRoot: path.resolve(config.dataRoot),
    stateHome: path.resolve(config.stateHome),
    projectIds: Object.freeze([...config.projectIds]),
    credentials: Object.freeze(config.credentials.map((credential) => Object.freeze({
      token: credential.token,
      projectIds: Object.freeze([...credential.projectIds]),
    }))),
  });
}

export function parseServerRuntimeConfig(value) {
  return validateConfig(value);
}

export async function loadServerRuntimeConfig(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw invalid("configuration path is required");
  }
  let text;
  try {
    const handle = await fs.open(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw invalid("configuration must be a regular non-symlink file");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw invalid("configuration file permissions must not grant group or other access");
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "INVALID_SERVER_CONFIG") throw error;
    throw invalid(`cannot read configuration file: ${error.message}`, error);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalid(`configuration is not valid JSON: ${error.message}`, error);
  }
  return validateConfig(value);
}
