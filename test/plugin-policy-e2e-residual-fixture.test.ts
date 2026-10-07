// Policy fixture package and export contract tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { FIXTURE_ID, FIXTURE_COMMAND, POLICY_FIXTURE_DIR } from "./plugin-policy-e2e-residual-helpers.ts";

test("fixture: package.json declares descriptor, type module, and no runtime dependencies", async () => {
  const pkgRaw = await fs.readFile(path.join(POLICY_FIXTURE_DIR, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.climier, {
    id: FIXTURE_ID,
    command: FIXTURE_COMMAND,
    entry: "./climier.mjs",
    api: 1,
  });
  for (const depKey of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    assert.ok(!(depKey in pkg), `fixture package.json must not declare ${depKey}`);
  }
});
test("fixture: default export exposes commands + policy with applies/authorize only", async () => {
  const mod = await import(path.join(POLICY_FIXTURE_DIR, "climier.mjs"));
  assert.ok(mod && typeof mod.default === "object" && mod.default !== null);
  const commands = mod.default.commands;
  assert.ok(commands && typeof commands === "object" && !Array.isArray(commands));
  for (const name of ["applies-check", "authorize-check", "recorded"]) {
    assert.equal(typeof commands[name], "function", `missing command '${name}'`);
  }
  const policy = mod.default.policy;
  assert.ok(policy && typeof policy === "object" && !Array.isArray(policy));

  assert.deepEqual(Object.keys(policy).toSorted(), ["applies", "authorize"]);
  assert.equal(typeof policy.applies, "function");
  assert.equal(typeof policy.authorize, "function");
});
