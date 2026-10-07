import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  inProcessIsolationArgs,
  listTestFiles,
  loadDurationTable,
  partitionShards,
  supportsInProcessIsolation,
} from "./core-test-plan.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const timeoutMs = Number(process.env.CLIMIER_TEST_TIMEOUT_MS || 180_000);

// In-process shards pay the test-runner bootstrap and the module graph once
// per shard instead of once per file (~100ms each). Sharding keeps the files
// parallel across CPUs while removing ~190 process bootstraps per run.
// Bun owns test isolation and does not accept Node's test-runner flags; its
// shards use `bun test <files>` directly. Node < 22.8 has no in-process
// isolation flag and keeps the process-isolated path. CLIMIER_TEST_ISOLATION=process
// forces that path for debugging isolation-sensitive failures.
const isBun = Boolean(process.versions.bun);
const supportsShards = isBun || supportsInProcessIsolation();
const isolation = isBun
  ? "none"
  : process.env.CLIMIER_TEST_ISOLATION === "process" || !supportsShards
    ? "process"
    : "none";
const workerCount = Math.max(
  1,
  Number(process.env.CLIMIER_TEST_WORKERS || os.availableParallelism() - 1) || 1,
);
const isolationArgs = isBun ? [] : supportsShards ? inProcessIsolationArgs(isolation) : [];

const files = await listTestFiles(testDir);
const durationTable = await loadDurationTable(path.join(testDir, "test-durations.json"), { rootDir });

// Partition with the regenerable duration table; without it (or for files it
// does not know) the plan falls back to a size estimate.
const shards = isolation === "none"
  ? await partitionShards(files, workerCount, { table: durationTable ?? undefined })
  : [files];
const single = shards.length === 1;

function spawnRunner(
  shardFiles: string[],
  { inheritsOutput, label }: { inheritsOutput: boolean; label: string },
): { child: ReturnType<typeof spawn>; completion: Promise<number> } {
  // In-process isolation shares process.env and cwd between test files. Keep
  // each shard's files sequential; the outer runner already parallelizes
  // independent shards.
  const concurrencyArgs = isBun ? [] : isolation === "none" ? ["--test-concurrency=1"] : [];
  const args = isBun
    ? ["test", "--timeout", "30000", ...shardFiles]
    : ["--test", ...concurrencyArgs, ...isolationArgs, ...shardFiles];
  const child = spawn(process.execPath, args, {
    stdio: inheritsOutput ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (inheritsOutput) {
    return { child, completion: new Promise((resolve) => {
      child.once("error", (error) => {
        console.error(`core test runner: ${error.message}`);
        resolve(1);
      });
      child.once("close", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    }) };
  }
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  const completion = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      output += `core test runner: ${error.message}\n`;
      resolve(1);
    });
    child.once("close", (code, signal) => {
      process.stdout.write(`${output.endsWith("\n") ? "" : "\n"}# ${label} (${shardFiles.length} files)\n${output}`);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
  return { child, completion };
}

const running: Array<{ child: ReturnType<typeof spawn>; completion: Promise<number> }> = [];
for (let index = 0; index < shards.length; index++) {
  running.push(spawnRunner(shards[index], {
    inheritsOutput: single,
    label: `shard ${index + 1}/${shards.length}`,
  }));
}

let timedOut = false;
let killTimer;
const timer = setTimeout(() => {
  timedOut = true;
  for (const { child } of running) {child.kill("SIGTERM");}
  killTimer = setTimeout(() => {
    for (const { child } of running) {child.kill("SIGKILL");}
  }, 10_000);
  killTimer.unref();
}, timeoutMs);
timer.unref();

const codes = await Promise.all(running.map(({ completion }) => completion));
clearTimeout(timer);
clearTimeout(killTimer);

if (timedOut) {
  console.error(`core test runner: timed out after ${timeoutMs}ms`);
  process.exitCode = 124;
} else {
  process.exitCode = codes.some((code) => code !== 0) ? 1 : 0;
}
