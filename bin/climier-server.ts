#!/usr/bin/env bun
import { checkServerConfig } from "../src/server/preflight.ts";

function usage() {
  process.stderr.write("usage: climier-server [--check <private-config.json> [--env-file P] [--probe-bind] [--strict]] | <private-config.json>\n");
  process.exitCode = 2;
}

const VALUE_OPTIONS = new Map([
  ["--check", "configPath"],
  ["--env-file", "envFile"],
]);
const BOOLEAN_OPTIONS = new Map([
  ["--probe-bind", { key: "probeBind", value: true }],
  ["--probe-bind=true", { key: "probeBind", value: true }],
  ["--probe-bind=false", { key: "probeBind", value: false }],
  ["--strict", { key: "strict", value: true }],
  ["--strict=true", { key: "strict", value: true }],
  ["--strict=false", { key: "strict", value: false }],
]);

function parseArgument(argv: string[], index: number) {
  const argument = argv[index];
  const valueKey = VALUE_OPTIONS.get(argument);
  if (valueKey !== undefined) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      return null;
    }
    return { nextIndex: index + 1, options: { [valueKey]: value } };
  }
  const option = BOOLEAN_OPTIONS.get(argument);
  if (option === undefined) {
    return null;
  }
  return { nextIndex: index, options: { [option.key]: option.value } };
}

function checkArguments(argv: string[]) {
  const options: { configPath?: string; envFile?: string; probeBind: boolean; strict: boolean } = {
    configPath: undefined,
    envFile: undefined,
    probeBind: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const parsed = parseArgument(argv, index);
    if (parsed === null) {
      return null;
    }
    Object.assign(options, parsed.options);
    index = parsed.nextIndex;
  }
  if (!options.configPath) {
    return null;
  }
  return options;
}

const argv = process.argv.slice(2);
if (argv[0] === "--check") {
  const options = checkArguments(argv);
  if (!options) {
    usage();
  } else {
    const result = await checkServerConfig(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
} else if (argv.length !== 1 || !argv[0] || argv[0].startsWith("--")) {
  usage();
} else {
  const configPath = argv[0];
  try {
    const { startServerRuntime } = await import("../src/server/runtime.ts");
    const runtime = await startServerRuntime(configPath);
    const address = runtime.server.address();
    process.stdout.write(`${JSON.stringify({ ok: true, host: address.address, port: address.port })}\n`);
    let shuttingDown = false;
    const shutdown = (exitCode = 0) => {
      if (shuttingDown) {return;}
      shuttingDown = true;
      runtime.server.close((error) => {
        if (error) {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
        } else {
          process.exitCode = exitCode;
        }
      });
    };
    process.once("SIGINT", () => shutdown());
    process.once("SIGTERM", () => shutdown());
    process.once("uncaughtException", (error) => {
      process.stderr.write(`${error.message}\n`);
      shutdown(1);
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
