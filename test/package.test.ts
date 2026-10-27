import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type PackageJson = {
  scripts: Record<string, unknown>;
  version: string;
  engines: Record<string, string>;
  bin: Record<string, string>;
  files: string[];
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
};
function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

test("package: published files include the built UI", () => {
  const pkg = readPackage();
  assert.ok(pkg.files.includes("ui/dist"), "the published file allowlist must include ui/dist");
});

test("package: the CLI ships no runtime dependencies", () => {
  const pkg = readPackage();
  // The root package is stdlib-only by design; ui/ and docs/ carry their own
  // manifests, so a runtime dependency here can only be an accident.
  assert.equal(pkg.dependencies, undefined, "the CLI must stay stdlib-only");
  assert.equal(pkg.optionalDependencies, undefined, "the CLI must stay stdlib-only");
  assert.equal(pkg.peerDependencies, undefined, "the CLI must stay stdlib-only");
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
