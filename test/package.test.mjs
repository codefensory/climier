import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package: npm test uses the bounded core runner", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node test/run-core-tests.mjs");
});

test("package: every published bin entry uses the portable Node shebang", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  for (const [name, relativePath] of Object.entries(pkg.bin)) {
    const firstLine = readFileSync(path.join(repoRoot, relativePath), "utf8").split("\n", 1)[0];
    assert.equal(firstLine, "#!/usr/bin/env node", `${name} must use the Node shebang`);
  }
});

test("package: the UI test suite is gone with its script and loader", async () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test:ui"], undefined, "no test:ui script survives the suite it ran");
  assert.equal(pkg.repository, undefined);
  assert.equal(pkg.homepage, undefined);
  assert.equal(pkg.bugs, undefined);
  const testDir = path.join(repoRoot, "test");
  const uiTests = (await readdir(testDir)).filter((name) => name.startsWith("ui-") && name.endsWith(".test.mjs"));
  assert.deepEqual(uiTests, [], "no root ui-* test file remains");
  assert.equal(existsSync(path.join(testDir, "jsx-loader.mjs")), false, "the JSX loader existed only for those files");
});

test("package: npm pack only includes runtime files", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const packed = JSON.parse(raw);
  // npm 10 returns an array here; npm 12 wraps the manifest by package name.
  const report = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const { files } = report;
  const paths = files.map((f) => f.path);

  assert.ok(paths.includes("bin/climier.mjs"));
  assert.ok(paths.some((p) => p.startsWith("src/")));
  assert.ok(paths.includes("LICENSE"));
  assert.ok(paths.includes("CHANGELOG.md"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("docs/reference.md"));

  assert.equal(paths.some((p) => p.startsWith("test/")), false);
  assert.ok(paths.includes("ui/dist/index.html"));
  const uiPaths = paths.filter((p) => p.startsWith("ui/"));
  assert.ok(uiPaths.length > 0);
  assert.equal(uiPaths.every((p) => p.startsWith("ui/dist/")), true);
  assert.equal(paths.includes("AGENTS.md"), false);
  assert.equal(paths.some((p) => p.startsWith(".agents/")), false);
});
