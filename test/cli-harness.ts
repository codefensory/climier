// CLI harness for tests: run the real dispatch pipeline in-process by
// default, or spawn bin/climier.ts when a test needs process isolation.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(testDirectory, "..", "bin", "climier.ts");

// The suite issues thousands of CLI calls, and one spawned node per call costs
// ~50ms of startup plus the dispatch module graph. Capturing write/exit keeps
// the public contract: { stdout, stderr, code }.
let dispatchModulePromise: Promise<DispatchModule> | undefined;

function loadDispatch(): Promise<DispatchModule> {
  dispatchModulePromise ??= import("../src/cli/dispatch.ts");
  return dispatchModulePromise;
}

type CliEnvironment = Record<string, string | undefined>;
type CliOptions = { cwd?: string; env?: CliEnvironment | string[] };
type CliArgs = string[] | Record<string, string> | undefined;
type CliResult = { stdout: string; stderr: string; code: number | null };

type DispatchModule = typeof import("../src/cli/dispatch.ts");

function normalizeArgs(args: CliArgs): string[] {
  return Array.isArray(args) ? args : [];
}

function normalizeEnv(env: CliOptions["env"]): CliEnvironment | undefined {
  return env !== undefined && !Array.isArray(env) ? env : undefined;
}

function applyEnvOverrides(env: CliEnvironment | undefined): Map<string, string | undefined> | null {
  if (!env || typeof env !== "object") {
    return null;
  }
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  return previous;
}

function restoreEnvOverrides(previous: Map<string, string | undefined> | null): void {
  if (!previous) {
    return;
  }
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export async function runCliInProcess(args: CliArgs, { cwd, env }: CliOptions = {}): Promise<CliResult> {
  const { runCli: dispatchRunCli } = await loadDispatch();
  const previousCwd = process.cwd();
  const ownsCwd = cwd === undefined;
  const effectiveCwd = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "climier-cli-test-"));
  const previousEnv = applyEnvOverrides({ ...normalizeEnv(env), NO_COLOR: "1" });
  const writes: string[] = [];
  let code = 0;
  let exited = false;
  try {
    process.chdir(effectiveCwd);
    const result = await dispatchRunCli({
      argv: normalizeArgs(args),
      // dispatch calls exit() inside the try/catch that also handles errors.
      // Record the code without throwing and suppress writes after exit so a
      // late path cannot append a second envelope.
      write: (value) => { if (!exited) { writes.push(String(value)); } },
      exit: (exitCode) => { code = exitCode ?? 0; exited = true; },
    });
    if (!exited && Number.isInteger(result)) {
      code = result;
    }
    return { stdout: writes.map((value) => `${value}\n`).join(""), stderr: "", code };
  } finally {
    restoreEnvOverrides(previousEnv);
    try {
      process.chdir(previousCwd);
    } finally {
      if (ownsCwd) {fs.rmSync(effectiveCwd, { recursive: true, force: true });}
    }
  }
}

export const runCli = runCliInProcess;

// Spawn the real bin. Kept for process-isolation tests only: concurrent calls
// share process.chdir/process.env, and stdin consumers need their own process.
export function runCliSpawn(args: CliArgs, { cwd, env }: CliOptions = {}): Promise<CliResult> {
  const ownsCwd = cwd === undefined;
  const childCwd = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "climier-cli-test-"));
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [BIN, ...normalizeArgs(args)], {
      cwd: childCwd,
      env: { ...process.env, ...normalizeEnv(env), NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.once("error", (error) => {
      if (ownsCwd) {fs.rmSync(childCwd, { recursive: true, force: true });}
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: null });
    });
    proc.once("close", (code) => {
      if (ownsCwd) {fs.rmSync(childCwd, { recursive: true, force: true });}
      resolve({ stdout, stderr, code });
    });
  });
}
