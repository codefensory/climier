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
  const [{ files }] = JSON.parse(raw);
  const paths = files.map((f) => f.path);

  assert.ok(paths.includes("bin/climier.mjs"));
  assert.ok(paths.some((p) => p.startsWith("src/")));
  assert.ok(paths.includes("LICENSE"));
  assert.ok(paths.includes("CHANGELOG.md"));

  assert.equal(paths.some((p) => p.startsWith("test/")), false);
  assert.equal(paths.includes("AGENTS.md"), false);
  assert.equal(paths.some((p) => p.startsWith(".agents/")), false);
});
