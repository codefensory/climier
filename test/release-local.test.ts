import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("release-please and the CI npm publish are retired", () => {
  assert.equal(existsSync(new URL("../release-please-config.json", import.meta.url)), false);
  assert.equal(existsSync(new URL("../.release-please-manifest.json", import.meta.url)), false);
  assert.equal(existsSync(new URL("../.github/workflows/release.yml", import.meta.url)), false);
  assert.doesNotMatch(ci, /NPM_TOKEN|npm publish/);
});

test("package.json exposes the local release script", () => {
  assert.equal(packageJson.scripts.release, "bun scripts/release.ts");
});
