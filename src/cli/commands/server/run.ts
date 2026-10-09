import { startServerRuntime } from "../../../server/runtime.ts";
import type { CommandContext } from "../contracts.ts";

export const knownFlags = [] as const;

type ServerRuntime = Awaited<ReturnType<typeof startServerRuntime>>;

type Address = { address: string; port: number };

function usageError(message: string, details: Record<string, unknown> = {}) {
  const error = new Error(`server run: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  error.details = details;
  return error;
}

async function waitForShutdown(runtime: ServerRuntime): Promise<void> {
  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const finish = (error?: Error) => {
      if (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("uncaughtException", onUncaughtException);
      resolve();
    };

    const shutdown = (exitCode = 0) => {
      if (shuttingDown) { return; }
      shuttingDown = true;
      runtime.server.close((error) => {
        if (error) {
          finish(error);
          return;
        }
        if (exitCode !== 0) { process.exitCode = exitCode; }
        finish();
      });
    };

    const onSignal = () => shutdown();
    const onUncaughtException = (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      shutdown(1);
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("uncaughtException", onUncaughtException);
  });
}

export default async function run({ positional, write }: CommandContext): Promise<undefined> {
  if (positional.length !== 1 || positional[0].length === 0) {
    throw usageError("requires exactly one private configuration path", { positional });
  }

  const runtime = await startServerRuntime(positional[0]);
  const address = runtime.server.address() as Address | string | null;
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    throw new Error("server run: runtime did not expose a listening address");
  }

  const health = JSON.stringify({ ok: true, host: address.address, port: address.port });
  if (write) {
    write(health);
  } else {
    process.stdout.write(`${health}\n`);
  }
  await waitForShutdown(runtime);
  return undefined;
}
