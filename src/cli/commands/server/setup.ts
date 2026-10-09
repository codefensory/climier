import path from "node:path";
import * as readline from "node:readline/promises";

import type { CliFlags, CommandContext } from "../contracts.ts";
import init, { knownFlags as initFlags } from "./init.ts";

export const knownFlags = initFlags;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "43127";
const DEFAULT_UNIT = "systemd";
const DEFAULT_SERVICE_NAME = "climier-server.service";
const BOOLEAN_FLAGS = new Set([
  "allow-missing-paths", "dry-run", "force", "rotate-password", "print-secret", "yes",
]);

type SetupContext = CommandContext & {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
};

function usageError(message: string, details: Record<string, unknown> = {}) {
  const error = new Error(`server setup: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  error.details = { valid_flags: [...initFlags], ...details };
  return error;
}

function ttyRequired(context: SetupContext, input: NodeJS.ReadableStream & { isTTY?: boolean }) {
  if (context.ask || context.isTTY === true || input.isTTY === true) {return;}
  const flags = initFlags.map((flag) => `--${flag}`).join(", ");
  throw usageError(`an interactive TTY is required (valid flags: ${flags})`);
}

function initialValue(flags: CliFlags, name: string, fallback: string): string {
  const value = flags[name];
  if (value === undefined) {return fallback;}
  return String(value);
}

// eslint-disable-next-line complexity -- The wizard's prompts mirror the complete init option set.
async function collectOptions(context: SetupContext, ask: (question: string) => Promise<string>): Promise<CliFlags> {
  const { flags, projectDir } = context;
  const root = (await ask(`Root directory [${initialValue(flags, "root", path.resolve(projectDir))}]: `)).trim()
    || initialValue(flags, "root", path.resolve(projectDir));
  const host = (await ask(`Listen host [${initialValue(flags, "host", DEFAULT_HOST)}]: `)).trim()
    || initialValue(flags, "host", DEFAULT_HOST);
  const port = (await ask(`Listen port [${initialValue(flags, "port", DEFAULT_PORT)}]: `)).trim()
    || initialValue(flags, "port", DEFAULT_PORT);
  const dataRoot = (await ask(`Data root [${initialValue(flags, "data-root", path.join(path.resolve(root), "data"))}]: `)).trim()
    || initialValue(flags, "data-root", path.join(path.resolve(root), "data"));
  const stateHome = (await ask(`State home [${initialValue(flags, "state-home", path.join(path.resolve(root), "state"))}]: `)).trim()
    || initialValue(flags, "state-home", path.join(path.resolve(root), "state"));
  const uiRoot = (await ask(`UI root [${initialValue(flags, "ui-root", "none")}]: `)).trim()
    || initialValue(flags, "ui-root", "");
  const serviceUser = (await ask(`Service user [${initialValue(flags, "service-user", "none")}]: `)).trim()
    || initialValue(flags, "service-user", "");
  const serviceName = (await ask(`Service name [${initialValue(flags, "service-name", DEFAULT_SERVICE_NAME)}]: `)).trim()
    || initialValue(flags, "service-name", DEFAULT_SERVICE_NAME);
  const unit = (await ask(`Service unit [${initialValue(flags, "unit", DEFAULT_UNIT)}]: `)).trim()
    || initialValue(flags, "unit", DEFAULT_UNIT);
  const options: CliFlags = {
    root, host, port, "data-root": dataRoot, "state-home": stateHome, "service-name": serviceName, unit,
  };
  if (uiRoot) {options["ui-root"] = uiRoot;}
  if (serviceUser) {options["service-user"] = serviceUser;}
  for (const flag of BOOLEAN_FLAGS) {
    const fallback = initialValue(flags, flag, "false");
    const value = (await ask(`${flag} [${fallback}]: `)).trim() || fallback;
    options[flag] = value;
  }
  return options;
}

export default async function setup(context: SetupContext) {
  if (context.positional.length > 0) {
    throw usageError("does not accept extra positional arguments", { positional: context.positional });
  }
  const input = context.input ?? process.stdin;
  ttyRequired(context, input);
  if (context.ask) {
    return init({ ...context, flags: await collectOptions(context, context.ask), positional: [] });
  }
  const output = context.output ?? process.stderr;
  const prompt = readline.createInterface({
    input: input as NodeJS.ReadableStream,
    output,
  });
  const lines = prompt[Symbol.asyncIterator]();
  try {
    const flags = await collectOptions(context, async (question) => {
      output.write(question);
      const line = await lines.next();
      if (line.done) {throw usageError("input ended before setup was complete");}
      return line.value;
    });
    return init({ ...context, flags, positional: [] });
  } finally {
    prompt.close();
  }
}
