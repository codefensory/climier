#!/usr/bin/env bun

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;
type Health = { ok: boolean; host: string; port: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForHealth(child: ServerProcess): Promise<Health> {
  return new Promise<Health>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`binary smoke: server health timed out: ${stderr}`))), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) { return; }
      finish(() => {
        try {
          resolve(JSON.parse(stdout.slice(0, newline)) as Health);
        } catch (error) {
          reject(new Error(`binary smoke: server health was not JSON: ${errorMessage(error)}`));
        }
      });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => reject(new Error(`binary smoke: server exited before health (${code}): ${stderr}`))));
  });
}

async function stopServer(child: ServerProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { return; }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function smokeBinary(executable: string): Promise<void> {
  const expectedIndex = await fs.readFile(path.join(repoRoot, "ui", "dist", "index.html"), "utf8");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-binary-smoke-"));
  const configPath = path.join(root, "server.json");
  const password = "climier-binary-smoke-password";
  await fs.writeFile(configPath, `${JSON.stringify({
    listen: { host: "127.0.0.1", port: 0 },
    dataRoot: path.join(root, "data"),
    stateHome: path.join(root, "state"),
  }, null, 2)}\n`, { mode: 0o600 });

  const child = spawn(path.resolve(executable), ["server", "run", configPath], {
    cwd: root,
    env: { ...process.env, CLIMIER_HOME: path.join(root, "home"), CLIMIER_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const health = await waitForHealth(child);
    if (health.ok !== true || health.host !== "127.0.0.1" || !Number.isInteger(health.port)) {
      throw new Error(`binary smoke: invalid server health: ${JSON.stringify(health)}`);
    }
    const response = await fetch(`http://127.0.0.1:${health.port}/`);
    if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) {
      throw new Error(`binary smoke: GET / returned HTTP ${response.status} with ${response.headers.get("content-type")}`);
    }
    const html = await response.text();
    if (html !== expectedIndex) {
      throw new Error("binary smoke: GET / did not return the embedded ui/dist/index.html");
    }
    console.log("binary smoke: GET / -> 200 text/html; embedded ui/dist/index.html served without uiRoot");
  } finally {
    await stopServer(child);
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  if (!executable) {
    throw new Error("usage: bun scripts/smoke-binary.ts <compiled-binary>");
  }
  await smokeBinary(executable);
}
