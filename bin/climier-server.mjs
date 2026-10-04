#!/usr/bin/env node
import { startServerRuntime } from "../src/server/runtime.mjs";

const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3) {
  process.stderr.write("usage: climier-server <private-config.json>\n");
  process.exitCode = 2;
} else {
  try {
    const runtime = await startServerRuntime(configPath);
    const address = runtime.server.address();
    process.stdout.write(`${JSON.stringify({ ok: true, host: address.address, port: address.port })}\n`);
    const shutdown = () => runtime.server.close(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("uncaughtException", (error) => {
      process.stderr.write(`${error.message}\n`);
      shutdown();
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
