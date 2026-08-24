import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

  assert.equal(paths.some((p) => p.startsWith("test/")), false);
  assert.equal(paths.includes("AGENTS.md"), false);
  assert.equal(paths.some((p) => p.startsWith(".agents/")), false);
});
