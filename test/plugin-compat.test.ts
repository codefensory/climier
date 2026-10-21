// plugin-compat.test.mjs — state write and init contracts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  stateFilePath,
  readState,
  writeState,
  writeCanonicalState,
  seedPluginFixture,
  baseState,
  seedPluginData,
  assertPluginDataPreserved,
} from "./plugin-compat-helpers.ts";

test("writeCanonicalState preserves `plugins` (root) and `nodes[id].plugins` on round-trip", async () => {
  const dir = await createTempProject();
  try {
    const base = await seedPluginFixture(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});



test("init on a fresh project writes emptyState() without `plugins` (plugins is optional)", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    const out = await init({ statePath: dir, flags: {}, projectDir: dir });
    assert.equal(out.ok, true);
    const after = await readState(dir);
    assert.equal(after.version, 1);
    assert.equal(after.revision, 1);
    assert.equal(after.plugins, undefined, "fresh emptyState() must not carry a `plugins` field");
  } finally {
    await rmTempProject(dir);
  }
});

test("init --force preserves root `plugins` (nodes are wiped, root plugins survive)", async () => {
  const dir = await createTempProject();
  try {
    const base = await seedPluginFixture(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: init } = await importFresh("./cli/commands/init.ts");
    const out = await init({ statePath: dir, flags: { force: true }, projectDir: dir });
    assert.equal(out.ok, true);
    const after = await readState(dir);
    // Root plugins preserved.
    assertPluginDataPreserved(after);
    // Nodes wiped (per-node plugins go with them — that's the wipe contract).
    assert.deepEqual(after.nodes, {});
    assert.deepEqual(after.edges, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("init --force on a state WITHOUT plugins writes emptyState() unchanged", async () => {
  const dir = await createTempProject();
  try {
    await seedPluginFixture(dir);
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: { force: true }, projectDir: dir });
    const after = await readState(dir);
    assert.equal(after.plugins, undefined);
    assert.deepEqual(after.nodes, {});
  } finally {
    await rmTempProject(dir);
  }
});

test("init --force fails closed on a corrupt SQLite database", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, { version: 1, revision: 0, nodes: {}, edges: [], initiatives: {}, log: [] });
    const { default: init } = await importFresh("./cli/commands/init.ts");
    const corrupt = Buffer.from("not a SQLite database");
    await (await import("node:fs/promises")).writeFile(stateFilePath(dir), corrupt);
    await assert.rejects(init({ statePath: dir, flags: { force: true }, projectDir: dir }));
    assert.deepEqual(await (await import("node:fs/promises")).readFile(stateFilePath(dir)), corrupt);
  } finally {
    await rmTempProject(dir);
  }
});
