// run-bun-tests.mjs: Bun dual-runtime core test runner (excludes ui-*).
//
// Runs each core test file in its OWN `bun test` process. This isolation is
// deliberate, not incidental: Bun's node:test shim leaks "inside test" state
// after a failing test, so every later file in a shared `bun test` process
// dies with `test() inside another test()` (ERR_NOT_IMPLEMENTED, see
// https://github.com/oven-sh/bun/issues/5090). Per-file processes keep one
// failure from cascading into a hundred.
//
// Exit code is 0 only when every file passes. Failures are listed by file so
// the Bun/Node gap list stays actionable without touching any test.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const perFileTimeoutMs = Number(process.env.CLIMIER_BUN_FILE_TIMEOUT_MS || 120_000);

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

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["test", file], { stdio: "inherit" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ file, ok: false, reason: "timeout" });
    }, perFileTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ file, ok: false, reason: error.message });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0 && !signal, reason: signal || code });
    });
  });
}

const failed = [];
for (const file of files) {
  console.log(`--- bun test ${path.relative(path.resolve(testDir, ".."), file)}`);
  const result = await runOne(file);
  if (!result.ok) failed.push(`${result.file} (exit ${result.reason})`);
}

if (failed.length > 0) {
  console.error(`\nbun test runner: ${failed.length}/${files.length} files failed:`);
  for (const entry of failed) console.error(`  - ${entry}`);
  process.exitCode = 1;
} else {
  console.log(`\nbun test runner: all ${files.length} files passed`);
}
