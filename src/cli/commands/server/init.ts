import path from "node:path";

import { generateServerArtifacts, type SetupOptions } from "../../../server/setup-artifacts.ts";
import type { CliFlags, CommandContext } from "../contracts.ts";

const BOOLEAN_FLAGS = ["allow-missing-paths", "dry-run", "force", "rotate-password", "print-secret", "yes"] as const;

type BooleanFlag = typeof BOOLEAN_FLAGS[number];

function usageError(message: string, details: Record<string, unknown> = {}) {
  const error = new Error(`server init: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  error.details = details;
  return error;
}

function stringFlag(flags: CliFlags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) { return undefined; }
  if (typeof value !== "string" || value.length === 0) {
    throw usageError(`--${name} requires a non-empty value`, { flag: name });
  }
  return value;
}

function booleanFlag(flags: CliFlags, name: BooleanFlag): boolean {
  const value = flags[name];
  if (value === undefined || value === false || value === "false") { return false; }
  if (value === true || value === "true") { return true; }
  throw usageError(`--${name} expects true or false`, { flag: name });
}

function portFlag(flags: CliFlags): number | undefined {
  const value = stringFlag(flags, "port");
  if (value === undefined) { return undefined; }
  if (!/^\d+$/u.test(value)) {
    throw usageError("--port requires an integer between 0 and 65535", { flag: "port" });
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw usageError("--port requires an integer between 0 and 65535", { flag: "port" });
  }
  return port;
}

function unitFlag(flags: CliFlags): SetupOptions["unit"] | undefined {
  const unit = stringFlag(flags, "unit");
  if (unit === undefined) { return undefined; }
  if (unit !== "systemd" && unit !== "none") {
    throw usageError("--unit must be systemd or none", { flag: "unit" });
  }
  return unit;
}

function addOption<Key extends keyof SetupOptions>(options: SetupOptions, key: Key, value: SetupOptions[Key] | undefined) {
  if (value !== undefined) { options[key] = value; }
}

function nextSteps(next: string[]): string[] {
  return [
    ...next,
    "climier link <server-origin>",
    "climier login --server <server-origin>",
    "climier init",
  ];
}

export const knownFlags = [
  "root", "host", "port", "data-root", "state-home", "ui-root", "service-user", "service-name",
  "unit", "allow-missing-paths", "dry-run", "force", "rotate-password", "print-secret", "yes",
] as const;

export default async function init({ flags }: CommandContext) {
  const root = stringFlag(flags, "root");
  if (root === undefined) { throw usageError("--root is required", { flag: "root" }); }
  const options: SetupOptions = {
    root: path.resolve(root),
    allowMissingPaths: booleanFlag(flags, "allow-missing-paths"),
    dryRun: booleanFlag(flags, "dry-run"),
    force: booleanFlag(flags, "force"),
    rotatePassword: booleanFlag(flags, "rotate-password"),
    printSecret: booleanFlag(flags, "print-secret"),
  };
  addOption(options, "host", stringFlag(flags, "host"));
  addOption(options, "port", portFlag(flags));
  addOption(options, "dataRoot", stringFlag(flags, "data-root"));
  addOption(options, "stateHome", stringFlag(flags, "state-home"));
  addOption(options, "uiRoot", stringFlag(flags, "ui-root"));
  addOption(options, "serviceUser", stringFlag(flags, "service-user"));
  addOption(options, "serviceName", stringFlag(flags, "service-name"));
  addOption(options, "unit", unitFlag(flags));
  booleanFlag(flags, "yes");
  const result = await generateServerArtifacts(options);
  return { ...result, next: nextSteps(result.next) };
}
