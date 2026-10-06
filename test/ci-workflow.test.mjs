import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("darwin-x64 binary job uses a supported Intel macOS runner", () => {
  assert.match(workflow, /- name: darwin-x64\s+os: macos-15-intel\s+target: bun-darwin-x64/);
});
