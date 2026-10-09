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

test("release workflow supports a manual publish of an existing tag", () => {
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tag:\s*\n/);
  assert.match(workflow, /tag:\s*\n\s+description:.*tag.*\n\s+required:\s+true\n\s+type:\s+string/);
  assert.match(workflow, /if:\s*\$\{\{\s*github\.event_name == ['\"]push['\"]\s*\}\}/);
  assert.match(workflow, /needs\.release-please\.outputs\.release_created == ['\"]true['\"]/);
  assert.doesNotMatch(workflow, /^\s+release:\s*$/m);
  assert.match(workflow, /github\.event_name == ['\"]workflow_dispatch['\"]/);
  assert.match(workflow, /inputs\.tag/);
  assert.match(workflow, /group: npm-publish-\$\{\{.*inputs\.tag.*needs\.release-please\.outputs\.tag_name/);
  assert.match(workflow, /ref:\s*\$\{\{\s*env\.RELEASE_TAG\s*\}\}/);
  assert.match(workflow, /run: bun run prepublishOnly/);
  assert.match(workflow, /tag_version="\$\{RELEASE_TAG#v\}"/);
  assert.match(workflow, /if \[ "\$tag_version" != "\$version" \]/);
  assert.match(workflow, /npm publish --access public --tag/);
});
