import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const timeoutMs = Number(process.env.CLIMIER_TEST_TIMEOUT_MS || 180_000);

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs") && !entry.name.startsWith("ui-")) files.push(entryPath);
  }
  return files;
}

const files = (await testFiles(testDir)).sort();

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
}, timeoutMs);

timer.unref();

child.once("error", (error) => {
  clearTimeout(timer);
  console.error(`core test runner: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    console.error(`core test runner: timed out after ${timeoutMs}ms`);
    process.exitCode = 124;
    return;
  }
  process.exitCode = signal ? 1 : (code ?? 1);
});
