// One ratchet for retired module paths and canonical read consumers.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("legacy root modules stay retired and canonical modules exist", async () => {
  for (const relative of [
    "src/agent.ts",
    "src/errors.ts",
    "src/domain.ts",
    "src/operations.ts",
    "src/v2.mjs",
    "src/policy.mjs",
    "src/providers/policy/index.mjs",
    "src/plugin-api.ts",
    "src/plugin-query.ts",
    "src/plugin-data.ts",
    "src/plugin-core-adapter.ts",
    "src/plugin-core-registry.ts",
  ]) {
    await assert.rejects(fs.access(path.join(ROOT, relative)), { code: "ENOENT" }, relative);
  }

  for (const relative of [
    "src/contracts/agent.ts",
    "src/contracts/errors.ts",
    "src/contracts/domain.ts",
    "src/contracts/operations.ts",
    "src/plugins/api.ts",
    "src/plugins/query.ts",
    "src/plugins/data.ts",
    "src/plugins/core-adapter.ts",
    "src/plugins/core-registry.ts",
    "src/plugins/policy.ts",
  ]) {
    await assert.doesNotReject(fs.access(path.join(ROOT, relative)), relative);
  }

  const policy = await import("../../src/plugins/policy.ts");
  for (const name of ["loadApplicablePolicy", "authorizeAction", "isPolicyError"]) {
    assert.equal(typeof policy[name], "function", `plugins/policy must export ${name}`);
  }
});

test("read consumers import the canonical read-model modules", async () => {
  const expectations: Array<[string, RegExp]> = [
    ["src/cli/commands/status.ts", /from "\.\.\/\.\.\/read-model\/status\.ts"/],
    ["src/cli/commands/context.ts", /from "\.\.\/\.\.\/read-model\/index\.ts"/],
    ["src/plugins/query.ts", /from "\.\.\/read-model\/index\.ts"/],
    ["src/server/http/ui-api.ts", /from "\.\.\/\.\.\/read-model\/ui\.ts"/],
  ];
  for (const [file, expected] of expectations) {
    const source = await fs.readFile(path.join(ROOT, file), "utf8");
    assert.match(source, expected, `${file} must use the canonical read model`);
    assert.doesNotMatch(source, /from ["'][^"']*v2\.(?:ts|mjs)["']/, `${file} must not use the retired v2 facade`);
  }
});
