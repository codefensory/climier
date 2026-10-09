import path from "node:path";

import { checkServerConfig } from "../../../server/preflight.ts";
import type { CommandContext } from "../contracts.ts";

export const knownFlags = ["config", "env-file", "probe-bind", "strict"];

function usageError(message: string, details: Record<string, unknown> = {}) {
  const error = new Error(`server doctor: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  error.details = details;
  return error;
}

function flagPath(flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined || value === true) {return undefined;}
  if (typeof value !== "string" || value.length === 0) {
    throw usageError(`--${name} requires a path`, { flag: name });
  }
  return value;
}

function enabled(value: unknown): boolean {
  return value === true || value === "true";
}

export default async function doctor({ projectDir, flags, positional }: CommandContext) {
  if (positional.length > 0) {
    throw usageError("does not accept positional arguments", { positional_count: positional.length });
  }
  const configPath = flagPath(flags, "config") ?? path.join(projectDir, "server.json");
  const envFile = flagPath(flags, "env-file") ?? path.join(projectDir, "server.env");
  return checkServerConfig({
    configPath,
    envFile,
    probeBind: enabled(flags["probe-bind"]),
    strict: enabled(flags.strict),
  });
}
