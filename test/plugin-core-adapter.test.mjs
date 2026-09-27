import { test } from "node:test";
import assert from "node:assert/strict";
import * as helpers from "./plugin-core-adapter-helpers.mjs";

// 1. createCore — module shape (no state, no kernel)
// =====================================================================

test("plugin-core-adapter: createCore returns { version: 1, run } with run being async", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  const core = createCore({ projectDir: "/tmp/whatever", agent: "alice", pluginId: "p.test" });
  assert.equal(core.version, 1);
  assert.equal(typeof core.run, "function");
});

test("plugin-core-adapter: routes execution through Application Operations", async () => {
  const source = await helpers.fsModule.readFile(
    helpers.pathModule.resolve(helpers.pathModule.dirname(new URL(import.meta.url).pathname), "../src/plugins/core-adapter.mjs"),
    "utf8",
  );
  assert.match(source, /from ["']\.\.\/application\/operations\/index\.mjs["']/);
  assert.match(source, /executeOperation\(/);
  assert.doesNotMatch(source, /from ["']\.\/core-registry\.mjs["']/);
  assert.doesNotMatch(source, /mutate\(\{/);
  assert.doesNotMatch(source, /REG\.lookup\(/);
});

test("plugin-core-adapter: createCore throws when projectDir is missing or empty", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  assert.throws(
    () => createCore({ projectDir: "", agent: "alice", pluginId: "p.test" }),
    /projectDir required/,
  );
  assert.throws(
    () => createCore({ agent: "alice", pluginId: "p.test" }),
    /projectDir required/,
  );
});

test("plugin-core-adapter: createCore throws when pluginId is missing or empty", async () => {
  const { createCore } = await helpers.importFresh(helpers.ADAPTER_MODULE);
  assert.throws(
    () => createCore({ projectDir: "/tmp/whatever", agent: "alice", pluginId: "" }),
    /pluginId required/,
  );
  assert.throws(
    () => createCore({ projectDir: "/tmp/whatever", agent: "alice" }),
    /pluginId required/,
  );
});

// =====================================================================
// 2. registry — bootstrapBuiltins exposes the 21-op contract
// =====================================================================

test("plugin-core-adapter: bootstrapBuiltins exposes exactly the 21 op IDs published by ADR-012 §2", async () => {
  const { bootstrapBuiltins } = await helpers.importFresh(helpers.REGISTRY_MODULE);
  const reg = bootstrapBuiltins();
  assert.equal(reg.ops.length, helpers.EXPECTED_OPS.length, `expected ${helpers.EXPECTED_OPS.length} ops, got ${reg.ops.length}`);
  for (const op of helpers.EXPECTED_OPS) {
    assert.ok(reg.has(op), `registry must expose '${op}'`);
    const entry = reg.lookup(op);
    assert.ok(entry && entry.provider, `entry for '${op}' carries a provider`);
    assert.equal(typeof entry.provider.prepare, "function");
    assert.equal(typeof entry.provider.apply, "function");
  }
});

// =====================================================================
