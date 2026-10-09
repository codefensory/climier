import type { CommandContext } from "./contracts.ts";

const SUBCOMMANDS = Object.freeze(["init", "doctor", "setup", "run"]);
const DOCTOR_FLAGS = new Set(["config", "env-file", "probe-bind", "strict"]);
const RUN_FLAGS = new Set<string>();

export const knownFlags = [
  "config", "env-file", "probe-bind", "strict",
  "root", "host", "port", "data-root", "state-home", "ui-root",
  "service-user", "service-name", "unit", "allow-missing-paths", "dry-run", "force",
  "rotate-password", "print-secret", "yes",
];

function usageError(message: string, details: Record<string, unknown> = {}) {
  const error = new Error(`server: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  error.details = { valid_subcommands: [...SUBCOMMANDS], ...details };
  return error;
}

function validateDoctorFlags(flags: CommandContext["flags"]) {
  const unsupported = Object.keys(flags).filter((key) => !DOCTOR_FLAGS.has(key) && key !== "project" && key !== "no-warnings");
  if (unsupported.length > 0) {
    throw usageError(`doctor: unknown flag --${unsupported[0]}`, { flag: unsupported[0] });
  }
}

async function runSubcommand(context: CommandContext, subcommand: string, positional: string[]) {
  if (subcommand === "doctor") {
    validateDoctorFlags(context.flags);
    const module = await import("./server/doctor.ts");
    return module.default({ ...context, positional: [] });
  }
  if (subcommand === "init") {
    const module = await import("./server/init.ts");
    return module.default({ ...context, positional: [] });
  }
  if (subcommand === "run") {
    const unsupported = Object.keys(context.flags).filter((key) => !RUN_FLAGS.has(key) && key !== "project" && key !== "no-warnings");
    if (unsupported.length > 0) {
      throw usageError(`run: unknown flag --${unsupported[0]}`, { flag: unsupported[0] });
    }
    if (positional.length !== 1) {
      throw usageError("run requires exactly one private configuration path", { positional });
    }
    const module = await import("./server/run.ts");
    return module.default({ ...context, positional });
  }
  const module = await import("./server/setup.ts");
  return module.default({ ...context, positional: [] });
}

export default async function server(context: CommandContext) {
  const [subcommand, ...extra] = context.positional;
  if (typeof subcommand !== "string" || !SUBCOMMANDS.includes(subcommand)) {
    throw usageError(
      `unknown subcommand '${subcommand ?? ""}' (valid subcommands: ${SUBCOMMANDS.join(", ")})`,
      { subcommand: subcommand ?? null },
    );
  }
  if (subcommand !== "run" && extra.length > 0) {
    throw usageError("does not accept extra positional arguments", { positional: extra });
  }
  return runSubcommand(context, subcommand, extra);
}
