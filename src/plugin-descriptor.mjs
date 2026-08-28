// T-plugin-install — plugin descriptor contract (ADR-005 §"Instalación e identidad").
//
// The descriptor lives in package.json under `climier`:
//   { "climier": { "id": "...", "command": "...", "entry": "./climier.mjs" } }
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

export function validatePluginId(id) {
  if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: climier.id must match ${PLUGIN_ID_RE}`,
      { id: typeof id === "string" ? id : null, pattern: PLUGIN_ID_RE.source },
    );
  }
  return id;
}

export function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new PluginInvalidDescriptor(
      "plugin-descriptor: climier descriptor missing or not an object",
      { descriptor: descriptor ?? null },
    );
  }
  const { id, command, entry } = descriptor;
  const validId = validatePluginId(id);
  if (typeof command !== "string" || !command.trim()) {
    throw new PluginInvalidDescriptor(
      "plugin-descriptor: climier.command must be a non-empty string",
      { command: typeof command === "string" ? command : null },
    );
  }
  if (typeof entry !== "string" || !entry.trim()) {
    throw new PluginInvalidDescriptor(
      "plugin-descriptor: climier.entry must be a non-empty string",
      { entry: typeof entry === "string" ? entry : null },
    );
  }
  return { id: validId, command, entry };
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
// `src/plugin-errors.mjs` under the `POLICY_*` namespace.
export async function importEntry(entryAbsPath) {
  let mod;
  try {
    const fileUrl = pathToFileURL(path.resolve(entryAbsPath)).href;
    mod = await import(fileUrl);
  } catch (err) {
    throw new PluginLoadFailed(
      `plugin-descriptor: failed to import entrypoint at ${entryAbsPath}: ${err.message}`,
      { entry: entryAbsPath, cause: err.message },
    );
  }
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
  // ADR-007 §"Entry único": optional `default.policy` with strict shape.
  // When the field is absent we return { mod, commands } — the same
  // shape command-only plugins have always returned — so existing
  // callers (plugin-loader, plugin-install) keep working unchanged.
  const policy = validatePolicyShape(mod.default.policy, entryAbsPath);
  return { mod, commands, policy };
}

// validatePolicyShape — return `undefined` when `default.policy` is
// absent; otherwise enforce the strict ADR-007 shape and return the
// validated object. Throws PluginLoadFailed with `details.field` set to
// the offending key path when the shape is invalid.
function validatePolicyShape(raw, entryAbsPath) {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginLoadFailed(
      `plugin-descriptor: entrypoint at ${entryAbsPath} has invalid default.policy (must be an object)`,
      { entry: entryAbsPath, field: "policy" },
    );
  }
  const keys = Object.keys(raw);
  const allowed = ["applies", "authorize"];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new PluginLoadFailed(
        `plugin-descriptor: entrypoint at ${entryAbsPath} has unknown default.policy.${key}`,
        { entry: entryAbsPath, field: "policy", unknown: key },
      );
    }
  }
  if (typeof raw.authorize !== "function") {
    throw new PluginLoadFailed(
      `plugin-descriptor: entrypoint at ${entryAbsPath} has invalid default.policy.authorize (must be a function)`,
      { entry: entryAbsPath, field: "policy.authorize" },
    );
  }
  if (raw.applies !== undefined && typeof raw.applies !== "function") {
    throw new PluginLoadFailed(
      `plugin-descriptor: entrypoint at ${entryAbsPath} has invalid default.policy.applies (must be a function when present)`,
      { entry: entryAbsPath, field: "policy.applies" },
    );
  }
  // `applies` is optional; we surface `undefined` rather than the
  // absent key so callers can short-circuit.
  const policy = { authorize: raw.authorize };
  if (typeof raw.applies === "function") policy.applies = raw.applies;
  return policy;
}
