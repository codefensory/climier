import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("the commit contract is enforced locally, not in CI", () => {
  assert.doesNotMatch(workflow, /commitlint/);
  assert.doesNotMatch(workflow, /commit-audit/);
});

test("darwin-x64 binary job uses a supported Intel macOS runner", () => {
  assert.match(workflow, /- name: darwin-x64\s+os: macos-15-intel\s+target: bun-darwin-x64/);
});

test("tag releases create the release when missing and idempotently upload the five assets", () => {
  assert.match(workflow, /bun scripts\/manifest\.ts --version "\$\{GITHUB_REF_NAME#v\}" --channel stable --dist dist --out dist\/manifest\.json/);
  assert.match(workflow, /sha256sum climier-linux-x64 climier-linux-arm64 climier-darwin-x64 climier-darwin-arm64 climier-windows-x64\.exe > SHA256SUMS/);
  assert.match(workflow, /gh release view "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /gh release upload "\$GITHUB_REF_NAME" dist\/\* --repo "\$GITHUB_REPOSITORY" --clobber/);
});
