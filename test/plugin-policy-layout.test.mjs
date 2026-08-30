import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("policy host lives under plugins without a provider re-export", async () => {
  await assert.rejects(
    fs.access(path.join(repoRoot, "src/policy.mjs")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    fs.access(path.join(repoRoot, "src/providers/policy/index.mjs")),
    { code: "ENOENT" },
  );

  const policy = await import("../src/plugins/policy.mjs");
  assert.equal(typeof policy.loadApplicablePolicy, "function");
  assert.equal(typeof policy.authorizeAction, "function");
  assert.equal(typeof policy.isPolicyError, "function");
});
