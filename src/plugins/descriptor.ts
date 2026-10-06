import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ErrorCode } from "../contracts/errors.ts";
import { isRecord } from "../application/types.ts";

export const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const PLUGIN_API_VERSION = 1;

type PluginDetails = Record<string, unknown>;
type PluginEnvelope = { ok: false; error: { code: ErrorCode; message: string; details: PluginDetails } };
export type PluginPolicy = {
  authorize: (...args: unknown[]) => unknown | Promise<unknown>;
  applies?: (...args: unknown[]) => unknown | Promise<unknown>;
};
export type PluginDescriptor = { id: string; command: string; entry: string; api: 1 };

export class PluginInvalidDescriptor extends Error {
  readonly code: ErrorCode = "PLUGIN_INVALID_DESCRIPTOR";
  details: PluginDetails;
  toJSON: () => PluginEnvelope;

  constructor(message: string, details: PluginDetails = {}) {
    super(message);
    this.details = details;
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

export class PluginLoadFailed extends Error {
  readonly code: ErrorCode = "PLUGIN_LOAD_FAILED";
  details: PluginDetails;
  toJSON: () => PluginEnvelope;

  constructor(message: string, details: PluginDetails = {}) {
    super(message);
    this.details = details;
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

export class PluginApiIncompatible extends Error {
  readonly code: ErrorCode = "PLUGIN_API_INCOMPATIBLE";
  readonly details: PluginDetails;
  toJSON: () => PluginEnvelope;

  constructor(received: unknown) {
    super(
      `plugin-descriptor: API version ${String(received ?? "missing")} is incompatible; host expects api: ${PLUGIN_API_VERSION}. Update the plugin descriptor to api: ${PLUGIN_API_VERSION}, rebuild the plugin, and reinstall it.`,
    );
    this.details = { required: PLUGIN_API_VERSION, received: received ?? null };
    this.toJSON = () => ({ ok: false, error: { code: this.code, message: this.message, details: this.details } });
  }
}

export function validatePluginId(id: unknown): string {
  if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: climier.id must match ${PLUGIN_ID_RE}`,
      { id: typeof id === "string" ? id : null, pattern: PLUGIN_ID_RE.source },
    );
  }
  return id;
}

function validateDescriptorField(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new PluginInvalidDescriptor(
    `plugin-descriptor: climier.${field} must be a non-empty string`,
    { [field]: typeof value === "string" ? value : null },
  );
}

export function validateDescriptor(descriptor: unknown): PluginDescriptor {
  if (!isRecord(descriptor)) {
    throw new PluginInvalidDescriptor(
      "plugin-descriptor: climier descriptor missing or not an object",
      { descriptor: descriptor ?? null },
    );
  }
  const validId = validatePluginId(descriptor.id);
  const command = validateDescriptorField(descriptor.command, "command");
  const entry = validateDescriptorField(descriptor.entry, "entry");
  if (descriptor.api !== PLUGIN_API_VERSION) {
    throw new PluginApiIncompatible(descriptor.api);
  }
  return { id: validId, command, entry, api: PLUGIN_API_VERSION };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readDescriptor(pkgJsonPath: string): Promise<PluginDescriptor> {
  let raw: string;
  try {
    raw = await fs.readFile(pkgJsonPath, "utf8");
  } catch (err: unknown) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: cannot read package.json at ${pkgJsonPath}: ${errorMessage(err)}`,
      { path: pkgJsonPath },
    );
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch (err: unknown) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: package.json at ${pkgJsonPath} is not valid JSON: ${errorMessage(err)}`,
      { path: pkgJsonPath },
    );
  }
  const descriptor = isRecord(pkg) ? pkg.climier : undefined;
  if (!descriptor) {
    throw new PluginInvalidDescriptor(
      `plugin-descriptor: package.json at ${pkgJsonPath} is missing the 'climier' field`,
      { path: pkgJsonPath },
    );
  }
  return validateDescriptor(descriptor);
}

async function importPluginModule(entryAbsPath: string): Promise<Record<string, unknown>> {
  try {
    const fileUrl = pathToFileURL(path.resolve(entryAbsPath)).href;
    return await import(fileUrl) as unknown as Record<string, unknown>;
  } catch (err: unknown) {
    throw new PluginLoadFailed(
      `plugin-descriptor: failed to import entrypoint at ${entryAbsPath}: ${errorMessage(err)}`,
      { entry: entryAbsPath, cause: errorMessage(err) },
    );
  }
}

function validateCommands(mod: Record<string, unknown>, entryAbsPath: string): Record<string, unknown> {
  if (!isRecord(mod.default)) {
    throw new PluginLoadFailed(
      `plugin-descriptor: entrypoint at ${entryAbsPath} has no default export object`,
      { entry: entryAbsPath },
    );
  }
  const commands = mod.default.commands;
  if (!isRecord(commands)) {
    throw new PluginLoadFailed(
      `plugin-descriptor: entrypoint at ${entryAbsPath} has no default.commands object`,
      { entry: entryAbsPath },
    );
  }
  return commands;
}

export async function importEntry(entryAbsPath: string): Promise<{
  mod: Record<string, unknown>;
  commands: Record<string, unknown>;
  policy: PluginPolicy | undefined;
}> {
  const mod = await importPluginModule(entryAbsPath);
  const commands = validateCommands(mod, entryAbsPath);
  const defaultExport = mod.default;
  const policy = validatePolicyShape(isRecord(defaultExport) ? defaultExport.policy : undefined, entryAbsPath);
  return { mod, commands, policy };
}

function policyLoadError(entryAbsPath: string, field: string, suffix: string, details: PluginDetails = {}): never {
  throw new PluginLoadFailed(
    `plugin-descriptor: entrypoint at ${entryAbsPath} has invalid default.policy${suffix}`,
    { entry: entryAbsPath, field, ...details },
  );
}

function validatePolicyKeys(raw: Record<string, unknown>, entryAbsPath: string): void {
  const unknownKey = Object.keys(raw).find((key) => !["applies", "authorize"].includes(key));
  if (unknownKey) {
    policyLoadError(entryAbsPath, "policy", `.${unknownKey}`, { unknown: unknownKey });
  }
}

function validatePolicyShape(raw: unknown, entryAbsPath: string): PluginPolicy | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    policyLoadError(entryAbsPath, "policy", " (must be an object)");
  }
  validatePolicyKeys(raw, entryAbsPath);
  validatePolicyMethod(raw, "authorize", entryAbsPath);
  validatePolicyMethod(raw, "applies", entryAbsPath, true);
  return typeof raw.applies === "function"
    ? { authorize: raw.authorize as PluginPolicy["authorize"], applies: raw.applies as PluginPolicy["applies"] }
    : { authorize: raw.authorize as PluginPolicy["authorize"] };
}

function validatePolicyMethod(raw: Record<string, unknown>, method: string, entryAbsPath: string, optional = false): void {
  if (optional && raw[method] === undefined) {
    return;
  }
  if (typeof raw[method] === "function") {
    return;
  }
  const suffix = optional ? `.applies (must be a function when present)` : `.authorize (must be a function)`;
  policyLoadError(entryAbsPath, `policy.${method}`, suffix);
}
