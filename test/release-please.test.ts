import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../release-please-config.json", import.meta.url), "utf8")) as {
  [key: string]: unknown;
};
const manifest = JSON.parse(readFileSync(new URL("../.release-please-manifest.json", import.meta.url), "utf8")) as Record<string, string>;
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("release-please config uses node releases with versioned tags and changelog sections", () => {
  assert.equal(config["release-type"], "node");
  assert.equal(config["include-v-in-tag"], true);
  assert.ok(Array.isArray(config["changelog-sections"]));
  assert.ok((config["changelog-sections"] as unknown[]).length > 0);
});

test("release-please starts from the package's bootstrap version", () => {
  assert.equal(manifest["."], "1.0.0");
});

test("release workflow delegates PR, tag, and GitHub Release creation to release-please", () => {
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /googleapis\/release-please-action@v4/);
  assert.match(workflow, /manifest-file:\s*\.release-please-manifest\.json/);
  assert.doesNotMatch(workflow, /skip-github-release/);
  assert.doesNotMatch(workflow, /release-type:/);
  assert.doesNotMatch(workflow, /package-name:/);
  assert.doesNotMatch(workflow, /include-v-in-tag:/);
});
