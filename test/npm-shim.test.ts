// Contract for the test-only npm stand-in used by the plugin install
// fixtures. The product relies on npm for one thing: resolving a local
// directory into <staging>/node_modules/<basename>. The shim must do exactly
// that and fail loudly for any other invocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(testDirectory, "fixtures", "npm-shim");

type ShimResult = { error?: Error; code: number | null; stdout: string; stderr: string };

function runShim(args: string[]): Promise<ShimResult> {
  return new Promise<ShimResult>((resolve) => {
    const proc = spawn(SHIM, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (error) => resolve({ error, code: null, stdout, stderr }));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assertRan(result) {
  if (result.error) {
    assert.fail(`npm-shim is not executable: ${result.error.message}`);
  }
}

test("npm-shim answers --version without spawning npm", async () => {
  const result = await runShim(["--version"]);
  assertRan(result);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("npm-shim resolves a local directory into node_modules/<basename>", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "climier-npm-shim-"));
  try {
    const source = path.join(root, "fixture-pkg");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "package.json"), "{}\n");
    const prefix = path.join(root, "staging");
    const result = await runShim(["install", "--prefix", prefix, "--no-audit", "--no-fund", source]);
    assertRan(result);
    assert.equal(result.code, 0, result.stderr);
    const link = path.join(prefix, "node_modules", "fixture-pkg");
    assert.equal((await fsp.lstat(link)).isSymbolicLink(), true);
    assert.equal(await fsp.realpath(link), await fsp.realpath(source));
    assert.equal((await fsp.stat(path.join(link, "package.json"))).isFile(), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("npm-shim fails loudly for unsupported invocations", async () => {
  const result = await runShim(["publish"]);
  assertRan(result);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /npm-shim: unsupported/);
});
