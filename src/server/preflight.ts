import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import path from "node:path";

import { parseServerRuntimeConfig } from "./runtime-config.ts";
import { errorProperties, isRecord } from "./types.ts";

const CONFIG_FIELDS = new Set(["listen", "dataRoot", "stateHome", "uiRoot"]);
const ENV_FIELDS = new Set(["CLIMIER_SERVER_PASSWORD", "CLIMIER_SERVER_MAX_BODY_BYTES"]);
const MAX_CONFIGURED_BODY_BYTES = 32 * 1024 * 1024;

type CheckStatus = "pass" | "warn" | "fail";
type Check = { id: string; status: CheckStatus; detail: string; fix: string | null };
type CheckOptions = {
  configPath?: string;
  envFile?: string;
  env?: Record<string, string | undefined>;
  probeBind?: boolean;
  strict?: boolean;
};

type ParsedConfig = ReturnType<typeof parseServerRuntimeConfig>;

function check(id: string, status: CheckStatus, detail: string, fix: string | null = null): Check {
  return { id, status, detail, fix };
}

function failureDetail(code: string, detail: string): string {
  return `${code}: ${detail}`;
}

async function readConfig(configPath: string) {
  let info;
  try {
    info = await fs.lstat(configPath);
  } catch (error) {
    return { error: check("config-file", "fail", failureDetail("INVALID_SERVER_CONFIG", `cannot read configuration file: ${errorProperties(error).message}`), "Provide a readable private configuration file.") };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { error: check("config-regular", "fail", failureDetail("INVALID_SERVER_CONFIG", "configuration must be a regular non-symlink file"), "Replace the path with a regular file.") };
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    return { error: check("config-permissions", "fail", failureDetail("INVALID_SERVER_CONFIG", "configuration file permissions must not grant group or other access"), "Set the configuration mode to 0600.") };
  }

  try {
    const handle = await fs.open(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const handleInfo = await handle.stat();
      if (!handleInfo.isFile()) {
        return { error: check("config-regular", "fail", failureDetail("INVALID_SERVER_CONFIG", "configuration must be a regular non-symlink file"), "Replace the path with a regular file.") };
      }
      return { text: await handle.readFile("utf8") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { error: check("config-file", "fail", failureDetail("INVALID_SERVER_CONFIG", `cannot read configuration file: ${errorProperties(error).message}`), "Provide a readable private configuration file.") };
  }
}

function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, sourceLine] of text.split("\n").entries()) {
    const line = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
    if (line.length === 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !ENV_FIELDS.has(match[1]) || Object.hasOwn(values, match[1])) {
      throw new Error(`line ${index + 1} must contain one allowed KEY=VALUE assignment`);
    }
    const value = match[2];
    if (/^(?:export\s|.*(?:[;'`]|\$\(|\\))/u.test(value)) {
      throw new Error(`line ${index + 1} contains shell syntax`);
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadEnvironment(options: CheckOptions, checks: Check[]) {
  if (options.envFile === undefined) {
    checks.push(check("env-file", "pass", "using process.env for server settings"));
    return options.env ?? process.env;
  }
  try {
    const text = await fs.readFile(options.envFile, "utf8");
    const values = parseEnvText(text);
    checks.push(check("env-file", "pass", `parsed ${options.envFile} without executing it`));
    return values;
  } catch (error) {
    checks.push(check("env-file", "fail", failureDetail("INVALID_ENV_FILE", errorProperties(error).message), "Use one exact KEY=VALUE assignment per line."));
    return {};
  }
}

async function nearestWritableDirectory(target: string): Promise<{ ok: boolean; detail: string }> {
  let candidate = path.resolve(target);
  while (true) {
    try {
      const info = await fs.stat(candidate);
      if (!info.isDirectory()) {
        return { ok: false, detail: `${target} exists but is not a directory` };
      }
      await fs.access(candidate, fsConstants.W_OK);
      return { ok: true, detail: `${target} exists and is writable` };
    } catch (error) {
      if (errorProperties(error).code !== "ENOENT") {
        return { ok: false, detail: `${target} is not writable: ${errorProperties(error).message}` };
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return { ok: false, detail: `${target} cannot be created` };
      }
      candidate = parent;
    }
  }
}

async function checkStoragePaths(config: ParsedConfig, checks: Check[]) {
  const results = await Promise.all([nearestWritableDirectory(config.dataRoot), nearestWritableDirectory(config.stateHome)]);
  if (results.every((result) => result.ok)) {
    checks.push(check("storage-paths", "pass", `dataRoot and stateHome are writable or can be created`));
  } else {
    checks.push(check("storage-paths", "fail", failureDetail("INVALID_SERVER_CONFIG", results.filter((result) => !result.ok).map((result) => result.detail).join("; ")), "Create both directories or make their existing parents writable."));
  }
}

async function checkUiRoot(uiRoot: string | undefined, strict: boolean, checks: Check[]) {
  if (uiRoot === undefined) {
    checks.push(check("ui-root", "pass", "using the packaged UI root"));
    return;
  }
  try {
    const info = await fs.stat(uiRoot);
    if (info.isDirectory() && (await fs.stat(path.join(uiRoot, "index.html")).then((index) => index.isFile()).catch(() => false))) {
      checks.push(check("ui-root", "pass", `${uiRoot} contains index.html`));
      return;
    }
  } catch {}
  checks.push(check("ui-root", strict ? "fail" : "warn", failureDetail("SERVER_UI_ROOT_MISSING", `${uiRoot} does not contain index.html`), "Build the UI or configure a uiRoot containing index.html."));
}

function checkEnvironmentValues(environment: Record<string, string | undefined>, checks: Check[]) {
  const password = environment.CLIMIER_SERVER_PASSWORD;
  if (typeof password !== "string" || password.length === 0) {
    checks.push(check("secret", "fail", failureDetail("SERVER_SECRET_MISSING", "CLIMIER_SERVER_PASSWORD is missing or empty"), "Set CLIMIER_SERVER_PASSWORD in the environment or env file."));
  } else {
    const uniqueCharacters = new Set(password).size;
    if (password.length < 12 || uniqueCharacters < 6) {
      checks.push(check("secret", "warn", "CLIMIER_SERVER_PASSWORD is present but appears low entropy", "Use a longer, randomly generated secret."));
    } else {
      checks.push(check("secret", "pass", "CLIMIER_SERVER_PASSWORD is present"));
    }
  }

  const rawMaxBody = environment.CLIMIER_SERVER_MAX_BODY_BYTES;
  if (rawMaxBody === undefined) {
    checks.push(check("max-body", "pass", "using the default maximum request body size"));
    return;
  }
  const maxBody = /^\d+$/u.test(rawMaxBody) ? Number(rawMaxBody) : NaN;
  if (!Number.isSafeInteger(maxBody) || maxBody < 1 || maxBody > MAX_CONFIGURED_BODY_BYTES) {
    checks.push(check("max-body", "fail", failureDetail("INVALID_SERVER_CONFIG", `CLIMIER_SERVER_MAX_BODY_BYTES must be an integer between 1 and ${MAX_CONFIGURED_BODY_BYTES}`), "Set CLIMIER_SERVER_MAX_BODY_BYTES to a value in range."));
  } else {
    checks.push(check("max-body", "pass", `maximum request body size is ${maxBody} bytes`));
  }
}

async function probeBind(config: ParsedConfig): Promise<unknown> {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once("error", resolve);
    server.listen(config.listen.port, config.listen.host, () => {
      server.close(() => resolve(null));
    });
  });
}

async function checkBind(config: ParsedConfig, strict: boolean, checks: Check[]) {
  const error = await probeBind(config);
  if (!error) {
    checks.push(check("bind", "pass", `listen address ${config.listen.host}:${config.listen.port} is available`));
    return;
  }
  const code = errorProperties(error).code;
  if (code === "EADDRINUSE" || code === "EACCES") {
    checks.push(check("bind", strict ? "fail" : "warn", failureDetail("SERVER_PORT_UNAVAILABLE", `cannot bind ${config.listen.host}:${config.listen.port}: ${errorProperties(error).message}`), "Stop the conflicting service or choose another listen address."));
    return;
  }
  checks.push(check("bind", "fail", failureDetail("INVALID_SERVER_CONFIG", `bind probe failed: ${errorProperties(error).message}`), "Correct the listen host and port."));
}

export async function checkServerConfig(optionsOrPath: CheckOptions | string = {}, extraOptions: Omit<CheckOptions, "configPath"> = {}) {
  const options: CheckOptions = typeof optionsOrPath === "string"
    ? { ...extraOptions, configPath: optionsOrPath }
    : optionsOrPath;
  const checks: Check[] = [];
  const configPath = options.configPath;
  if (typeof configPath !== "string" || configPath.length === 0) {
    checks.push(check("config-file", "fail", failureDetail("INVALID_SERVER_CONFIG", "configuration path is required"), "Pass a private server configuration path."));
  }

  const environment = await loadEnvironment(options, checks);
  let parsedConfig: ParsedConfig | undefined;
  if (typeof configPath === "string" && configPath.length > 0) {
    const source = await readConfig(configPath);
    if (source.error) {
      checks.push(source.error);
    } else {
      let value: unknown;
      try {
        value = JSON.parse(source.text);
        checks.push(check("config-json", "pass", "configuration is valid JSON"));
      } catch (error) {
        checks.push(check("config-json", "fail", failureDetail("INVALID_SERVER_CONFIG", `configuration is not valid JSON: ${errorProperties(error).message}`), "Write valid JSON to the configuration file."));
      }
      if (value !== undefined) {
        if (!isRecord(value)) {
          checks.push(check("config-shape", "fail", failureDetail("INVALID_SERVER_CONFIG", "configuration must be a JSON object"), "Use a JSON object with listen, dataRoot, stateHome, and optional uiRoot."));
        } else {
          const legacyKeys = Object.keys(value).filter((key) => key === "credentials" || key === "projectIds");
          const unknownKeys = Object.keys(value).filter((key) => !CONFIG_FIELDS.has(key) && !legacyKeys.some((legacyKey) => legacyKey === key));
          if (legacyKeys.length > 0) {
            checks.push(check("config-keys", "fail", failureDetail("SERVER_LEGACY_CONFIG", `legacy keys are not supported: ${legacyKeys.join(", ")}`), "Remove credentials and projectIds and use the current server configuration shape."));
          } else if (unknownKeys.length > 0) {
            checks.push(check("config-keys", "fail", failureDetail("INVALID_SERVER_CONFIG", `unknown configuration keys: ${unknownKeys.join(", ")}`), "Remove keys not listed in the server configuration contract."));
          } else {
            checks.push(check("config-keys", "pass", "configuration contains only known keys"));
            try {
              parsedConfig = parseServerRuntimeConfig(value);
              checks.push(check("config-shape", "pass", "configuration shape and absolute paths are valid"));
            } catch (error) {
              checks.push(check("config-shape", "fail", failureDetail("INVALID_SERVER_CONFIG", errorProperties(error).message), "Fix the listen, dataRoot, stateHome, and uiRoot values."));
            }
          }
        }
      }
    }
  }

  checkEnvironmentValues(environment, checks);
  if (parsedConfig) {
    await checkStoragePaths(parsedConfig, checks);
    await checkUiRoot(parsedConfig.uiRoot, options.strict === true, checks);
    if (options.probeBind === true) {
      await checkBind(parsedConfig, options.strict === true, checks);
    }
  }

  return {
    ok: !checks.some((item) => item.status === "fail"),
    checks,
  };
}
