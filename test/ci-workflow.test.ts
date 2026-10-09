import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("darwin-x64 binary job uses a supported Intel macOS runner", () => {
  assert.match(workflow, /- name: darwin-x64\s+os: macos-15-intel\s+target: bun-darwin-x64/);
});

test("tag releases generate and idempotently upload the five release assets", () => {
  assert.match(workflow, /bun scripts\/manifest\.ts --version "\$\{GITHUB_REF_NAME#v\}" --channel stable --dist dist --out dist\/manifest\.json/);
  assert.match(workflow, /sha256sum climier-linux-x64 climier-linux-arm64 climier-darwin-x64 climier-darwin-arm64 climier-windows-x64\.exe > SHA256SUMS/);
  assert.match(workflow, /gh release upload "\$GITHUB_REF_NAME" dist\/\* --repo "\$GITHUB_REPOSITORY" --clobber/);
  assert.doesNotMatch(workflow, /gh release create/);
});
