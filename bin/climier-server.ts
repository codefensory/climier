#!/usr/bin/env bun
import { checkServerConfig } from "../src/server/preflight.ts";

function usage() {
  process.stderr.write("usage: climier-server [--check <private-config.json> [--env-file P] [--probe-bind] [--strict]] | <private-config.json>\n");
  process.exitCode = 2;
}

function checkArguments(argv: string[]) {
  let configPath;
  let envFile;
  let probeBind = false;
  let strict = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) return null;
      configPath = value;
    } else if (argument === "--env-file") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) return null;
      envFile = value;
    } else if (argument === "--probe-bind" || argument === "--probe-bind=true") {
      probeBind = true;
    } else if (argument === "--probe-bind=false") {
      probeBind = false;
    } else if (argument === "--strict" || argument === "--strict=true") {
      strict = true;
    } else if (argument === "--strict=false") {
      strict = false;
    } else {
      return null;
    }
  }
  if (typeof configPath !== "string" || configPath.length === 0) {
    return null;
  }
  return { configPath, envFile, probeBind, strict };
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
