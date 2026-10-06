import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { errorProperties, isRecord } from "./types.ts";

const CONFIG_FIELDS = new Set(["listen", "dataRoot", "stateHome", "uiRoot"]);
const LISTEN_FIELDS = new Set(["host", "port"]);

function invalid(message: string, cause?: unknown) {
  return Object.assign(new Error(`server config: ${message}`, cause ? { cause } : undefined), {
    code: "INVALID_SERVER_CONFIG",
  });
}

function hasOnlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function isLoopbackHost(host) {
  if (host === "localhost") {
    return true;
  }
  if (net.isIPv4(host)) {
    return host.split(".")[0] === "127";
  }
  return host === "::1" || host === "0:0:0:0:0:0:0:1";
}

function isTailscaleIPv4(host) {
  if (!net.isIPv4(host)) {return false;}
  const [first, second] = host.split(".").map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

function assignedToTailscale0(host, networkInterfaces) {
  if (!isTailscaleIPv4(host)) {return false;}
  return (networkInterfaces.tailscale0 || []).some((entry) =>
    entry?.address === host && (entry.family === "IPv4" || entry.family === 4));
}

function allowedListenHost(host, { allowTailscaleHttp, networkInterfaces }) {
  return isLoopbackHost(host)
    || (allowTailscaleHttp && assignedToTailscale0(host, networkInterfaces));
}

function hasValidListenShape(listen) {
  return hasOnlyKeys(listen, LISTEN_FIELDS)
    && typeof listen.host === "string" && listen.host.length > 0
    && Number.isInteger(listen.port) && listen.port >= 0 && listen.port <= 65_535;
}

function validateListenConfig(listen, options) {
  if (!hasValidListenShape(listen)) {
    throw invalid("expected only listen { host, port }, dataRoot, stateHome, and uiRoot");
  }
  if (!allowedListenHost(listen.host, options)) {
    throw invalid("listen.host must be loopback, or the assigned tailscale0 IPv4 with CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP=true");
  }
}

function validatePaths(config) {
  for (const key of ["dataRoot", "stateHome"]) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) {
      throw invalid(`${key} must be an absolute path`);
    }
  }
  if (config.uiRoot !== undefined && (typeof config.uiRoot !== "string" || !path.isAbsolute(config.uiRoot))) {
    throw invalid("uiRoot must be an absolute path");
  }
}

function normalizeConfig(config) {
  return Object.freeze({
    listen: Object.freeze({ ...config.listen }),
    dataRoot: path.resolve(config.dataRoot),
    stateHome: path.resolve(config.stateHome),
    uiRoot: config.uiRoot === undefined ? undefined : path.resolve(config.uiRoot),
  });
}

function validateConfig(config, {
  allowTailscaleHttp = process.env.CLIMIER_SERVER_ALLOW_TAILSCALE_HTTP === "true",
  networkInterfaces = os.networkInterfaces(),
} = {}) {
  if (!hasOnlyKeys(config, CONFIG_FIELDS)) {
    throw invalid("expected only listen { host, port }, dataRoot, stateHome, and uiRoot; projectIds and credentials are no longer supported");
  }
  validateListenConfig(config.listen, { allowTailscaleHttp, networkInterfaces });
  validatePaths(config);
  return normalizeConfig(config);
}

export function parseServerRuntimeConfig(value, options = {}) {
  return validateConfig(value, options);
}

async function readConfigText(configPath) {
  try {
    const handle = await fs.open(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw invalid("configuration must be a regular non-symlink file");
      }
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw invalid("configuration file permissions must not grant group or other access");
      }
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorProperties(error).code === "INVALID_SERVER_CONFIG") {
      throw error;
    }
    throw invalid(`cannot read configuration file: ${errorProperties(error).message}`, error);
  }
}

function parseConfigJson(text) {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return parsed;
    return parsed;
  } catch (error) {
    throw invalid(`configuration is not valid JSON: ${errorProperties(error).message}`, error);
  }
}

export async function loadServerRuntimeConfig(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw invalid("configuration path is required");
  }
  return validateConfig(parseConfigJson(await readConfigText(configPath)));
}
