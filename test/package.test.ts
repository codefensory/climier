import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type PackageJson = {
  scripts: Record<string, unknown>;
  version: string;
  engines: Record<string, string>;
  bin: Record<string, string>;
  files: string[];
  repository?: unknown;
  homepage?: unknown;
  bugs?: unknown;
};
function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

test("package: bun test uses the bounded core runner", () => {
  const pkg = readPackage();
  assert.equal(pkg.scripts.test, "bun test/run-core-tests.ts");
  assert.equal(pkg.version, "1.2.1");
  assert.deepEqual(pkg.engines, { bun: ">=1.4" });
  assert.deepEqual(pkg.bin, { climier: "./bin/climier.ts" });
  assert.equal(existsSync(path.join(repoRoot, "package-lock.json")), false);
  assert.equal(existsSync(path.join(repoRoot, "bun.lock")), true);
});

test("package: README documents Bun-only runtime usage", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /Bun 1\.4\+/);
  assert.doesNotMatch(readme, /\bnpx\b/i);
  assert.doesNotMatch(readme, /Node 20\+/i);
});

test("package: published files include the built UI", () => {
  const pkg = readPackage();
  assert.ok(pkg.files.includes("ui/dist"), "the published file allowlist must include ui/dist");
});

test("package: release smoke builds the UI and checks a compiled binary", () => {
  const pkg = readPackage();
  assert.equal(pkg.scripts["build:ui"], "bun install --cwd ui --frozen-lockfile && bun run --cwd ui build");
  assert.match(String(pkg.scripts["smoke:pack"]), /bun install --cwd ui --frozen-lockfile/);
  assert.match(String(pkg.scripts["smoke:pack"]), /bun run --cwd ui build/);
  const packedSmoke = readFileSync(path.join(repoRoot, "scripts/smoke-packed.ts"), "utf8");
  assert.match(packedSmoke, /build:binary/u);
  assert.match(packedSmoke, /smokeBinary/u);
  assert.match(String(pkg.scripts.prepublishOnly), /bun run build:ui/);
  assert.match(String(pkg.scripts.prepublishOnly), /RELEASE_TAG/);
});

test("package: every published bin entry uses the Bun shebang", () => {
  const pkg = readPackage();
  for (const [name, relativePath] of Object.entries(pkg.bin)) {
    const firstLine = readFileSync(path.join(repoRoot, relativePath), "utf8").split("\n", 1)[0];
    assert.equal(firstLine, "#!/usr/bin/env bun", `${name} must use the Bun shebang`);
  }
  const smokeShebang = readFileSync(path.join(repoRoot, "scripts/smoke-packed.ts"), "utf8").split("\n", 1)[0];
  assert.equal(smokeShebang, "#!/usr/bin/env bun");
});

test("package: the UI test suite is gone with its script and loader", async () => {
  const pkg = readPackage();
  assert.equal(pkg.scripts["test:ui"], undefined, "no test:ui script survives the suite it ran");
  assert.equal(pkg.repository, undefined);
  assert.equal(pkg.homepage, undefined);
  assert.equal(pkg.bugs, undefined);
  const testDir = path.join(repoRoot, "test");
  const uiTests = (await readdir(testDir)).filter((name) => name.startsWith("ui-") && name.endsWith(".test.mjs"));
  assert.deepEqual(uiTests, [], "no root ui-* test file remains");
  assert.equal(existsSync(path.join(testDir, "jsx-loader.mjs")), false, "the JSX loader existed only for those files");
});

test("package: bun pm pack only includes runtime files", () => {
  const raw = execFileSync("bun", ["pm", "pack", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const paths = raw.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^packed \S+ (.+)$/);
    return match ? [match[1]] : [];
  });

  assert.ok(paths.includes("bin/climier.ts"));
  assert.ok(paths.some((p) => p.startsWith("src/")));
  assert.ok(paths.includes("LICENSE"));
  assert.ok(paths.includes("CHANGELOG.md"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("docs/reference.md"));

  assert.equal(paths.some((p) => p.startsWith("test/")), false);
  const uiDistExists = existsSync(path.join(repoRoot, "ui", "dist"));
  const uiPaths = paths.filter((p) => p.startsWith("ui/"));
  if (uiDistExists) {
    assert.ok(uiPaths.some((p) => p.startsWith("ui/dist/")));
  }
  assert.equal(uiPaths.every((p) => p.startsWith("ui/dist/")), true);
  assert.equal(paths.some((p) => p.startsWith("ui/src/")), false);
  assert.equal(paths.some((p) => p.startsWith("ui/node_modules/")), false);
  assert.equal(paths.includes("AGENTS.md"), false);
  assert.equal(paths.some((p) => p.startsWith(".agents/")), false);
});
