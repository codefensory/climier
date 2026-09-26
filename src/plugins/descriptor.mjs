// Plugin descriptor contract (ADR-021 §Decision 6).
//
// The descriptor lives in package.json under `climier`:
//   { "climier": { "id": "...", "command": "...", "entry": "./climier.mjs", "api": 3 } }
//
// API compatibility is checked while reading the descriptor, before the
// entrypoint is imported. This keeps an unsupported plugin from executing
// import-time code against a host that cannot provide its contract.
//
// This module validates the shape and id regex, and imports the entrypoint
// as ESM to ensure it has a default.commands object. All errors are thrown
// with structured `code` + `details` so the CLI entry can emit the same
// JSON envelope as core v2 errors (bin/climier.mjs already handles
// {code, message, details} errors).

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ADR-005 §"Instalación e identidad": id must match this regex.
export const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const PLUGIN_API_VERSION = 3;

export class PluginInvalidDescriptor extends Error {
  constructor(message, details = {}) {
    super(message);
    this.code = "PLUGIN_INVALID_DESCRIPTOR";
    this.details = details;
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

export class PluginLoadFailed extends Error {
  constructor(message, details = {}) {
    super(message);
    this.code = "PLUGIN_LOAD_FAILED";
    this.details = details;
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

export class PluginApiIncompatible extends Error {
  constructor(received) {
    super(
      `plugin-descriptor: API version ${String(received ?? "missing")} is incompatible; host supports API version ${PLUGIN_API_VERSION}`,
    );
    this.code = "PLUGIN_API_INCOMPATIBLE";
    this.details = { required: PLUGIN_API_VERSION, received: received ?? null };
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

export function validatePluginId(id) {
  if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: climier.id must match ${PLUGIN_ID_RE}`,
      { id: typeof id === "string" ? id : null, pattern: PLUGIN_ID_RE.source },
    );
  }
  return id;
}

function validateDescriptorField(value, field) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new PluginInvalidDescriptor(
    `plugin-descriptor: climier.${field} must be a non-empty string`,
    { [field]: typeof value === "string" ? value : null },
  );
}

export function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new PluginInvalidDescriptor(
      "plugin-descriptor: climier descriptor missing or not an object",
      { descriptor: descriptor ?? null },
    );
  }
  const { id, command, entry, api } = descriptor;
  const validId = validatePluginId(id);
  validateDescriptorField(command, "command");
  validateDescriptorField(entry, "entry");
  if (api !== PLUGIN_API_VERSION) {
    throw new PluginApiIncompatible(api);
  }
  return { id: validId, command, entry, api };
}

// readDescriptor: load and validate a package.json's climier field.
// Used both pre-install (local sources) and post-install (npm sources).
export async function readDescriptor(pkgJsonPath) {
  let raw;
  try {
    raw = await fs.readFile(pkgJsonPath, "utf8");
  } catch (err) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: cannot read package.json at ${pkgJsonPath}: ${err.message}`,
      { path: pkgJsonPath },
    );
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: package.json at ${pkgJsonPath} is not valid JSON: ${err.message}`,
      { path: pkgJsonPath },
    );
  }
  const descriptor = pkg && pkg.climier;
  if (!descriptor) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: package.json at ${pkgJsonPath} is missing the 'climier' field`,
      { path: pkgJsonPath },
    );
  }
  return validateDescriptor(descriptor);
}

// importEntry: dynamic-import an ESM entrypoint and assert that
// default.commands is a plain object. Returns { mod, commands } so callers
// can reuse either.
//
// ADR-007 §"Entry único": `default.policy` is OPTIONAL. When present,
// `policy.authorize` MUST be a function; `policy.applies` MUST be a
// function when present; extra fields are rejected. An invalid
// `default.policy` invalidates the entire plugin (its commands are not
// exposed). The shape check re-uses `PluginLoadFailed` — the same code
// that guards `default.commands` — so the descriptor module emits one
// envelope for "shape is broken at load time". Runtime policy errors
// (`applies`/`authorize` throw or return invalid responses) live in
// `src/plugins/errors.mjs` under the `POLICY_*` namespace.
async function importPluginModule(entryAbsPath) {
  try {
    const fileUrl = pathToFileURL(path.resolve(entryAbsPath)).href;
    return await import(fileUrl);
  } catch (err) {
    throw new PluginLoadFailed(
      `plugin-descriptor: failed to import entrypoint at ${entryAbsPath}: ${err.message}`,
      { entry: entryAbsPath, cause: err.message },
    );
  }
}

function validateCommands(mod, entryAbsPath) {
  if (!mod || typeof mod.default !== "object" || mod.default === null || Array.isArray(mod.default)) {
    throw new PluginLoadFailed(
      `plugin-descriptor: entrypoint at ${entryAbsPath} has no default export object`,
      { entry: entryAbsPath },
    );
  }
  const commands = mod.default.commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    throw new PluginLoadFailed(
      `plugin-descriptor: entrypoint at ${entryAbsPath} has no default.commands object`,
      { entry: entryAbsPath },
    );
  }
  return commands;
}

export async function importEntry(entryAbsPath) {
  const mod = await importPluginModule(entryAbsPath);
  const commands = validateCommands(mod, entryAbsPath);
  const policy = validatePolicyShape(mod.default.policy, entryAbsPath);
  return { mod, commands, policy };
}

// validatePolicyShape — return `undefined` when `default.policy` is
// absent; otherwise enforce the strict ADR-007 shape and return the
// validated object. Throws PluginLoadFailed with `details.field` set to
// the offending key path when the shape is invalid.
function policyLoadError(entryAbsPath, field, suffix, details = {}) {
  throw new PluginLoadFailed(
    `plugin-descriptor: entrypoint at ${entryAbsPath} has invalid default.policy${suffix}`,
    { entry: entryAbsPath, field, ...details },
  );
}

function validatePolicyKeys(raw, entryAbsPath) {
  const unknownKey = Object.keys(raw).find((key) => !["applies", "authorize"].includes(key));
  if (unknownKey) {
    policyLoadError(entryAbsPath, "policy", `.${unknownKey}`, { unknown: unknownKey });
  }
}

function validatePolicyShape(raw, entryAbsPath) {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    policyLoadError(entryAbsPath, "policy", " (must be an object)");
  }
  validatePolicyKeys(raw, entryAbsPath);
  validatePolicyMethod(raw, "authorize", entryAbsPath);
  validatePolicyMethod(raw, "applies", entryAbsPath, true);
  return typeof raw.applies === "function"
    ? { authorize: raw.authorize, applies: raw.applies }
    : { authorize: raw.authorize };
}

function validatePolicyMethod(raw, method, entryAbsPath, optional = false) {
  if (optional && raw[method] === undefined) {
    return;
  }
  if (typeof raw[method] === "function") {
    return;
  }
  const suffix = optional ? ".applies (must be a function when present)" : ".authorize (must be a function)";
  policyLoadError(entryAbsPath, `policy.${method}`, suffix);
}
