// Test helpers: isolated temp projects for each test.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const BIN = path.resolve(__dirname, "..", "bin", "climier.mjs");

// Create an empty temp project dir with .agents/tasks/ ready.
export async function createTempProject() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-test-"));
  await fsp.mkdir(path.join(dir, ".agents", "tasks"), { recursive: true });
  return dir;
}

export async function rmTempProject(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function writeState(dir, state) {
  const file = path.join(dir, ".agents", "tasks", "tasks.json");
  await fsp.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function readState(dir) {
  const file = path.join(dir, ".agents", "tasks", "tasks.json");
  const raw = await fsp.readFile(file, "utf8");
  return JSON.parse(raw);
}

export async function stateExists(dir) {
  try {
    await fsp.access(path.join(dir, ".agents", "tasks", "tasks.json"));
    return true;
  } catch {
    return false;
  }
}

// Run the CLI as a child process. Returns { stdout, stderr, code }.
import { spawn } from "node:child_process";
export function runCli(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", [BIN, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// Import a src module fresh (bypass module cache between tests).
export async function importFresh(modulePath) {
  const url = new URL(modulePath, `file://${SRC_DIR}/`).href;
  return import(`${url}?t=${Date.now()}-${Math.random()}`);
}

export { SRC_DIR, BIN };
