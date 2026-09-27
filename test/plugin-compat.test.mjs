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
  fsp_writeFile,
} from "./plugin-compat-helpers.mjs";

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

test("legacy raw updateState preserves `plugins` (root) and `nodes[id].plugins` when a mutator touches a node", async () => {
  const dir = await createTempProject();
  try {
    const base = baseState();
    seedPluginData(base);
    await writeState(dir, base);
    const { updateState } = await importFresh("./storage/state.mjs");
    await updateState(dir, (st) => {
      st.nodes["T1"].title = "T1 (mutated)";
      return st;
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.title, "T1 (mutated)");
  } finally {
    await rmTempProject(dir);
  }
});

test("legacy raw updateState preserves `plugins` (root) when a mutator touches an unrelated collection (edges)", async () => {
  const dir = await createTempProject();
  try {
    const base = baseState();
    seedPluginData(base);
    await writeState(dir, base);
    const { updateState } = await importFresh("./storage/state.mjs");
    await updateState(dir, (st) => {
      st.edges.push({ from: "T1", to: "T2", type: "BLOCKS" });
      return st;
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.deepEqual(after.edges, [{ from: "T1", to: "T2", type: "BLOCKS" }]);
  } finally {
    await rmTempProject(dir);
  }
});

test("init on a fresh project writes emptyState() without `plugins` (plugins is optional)", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.mjs");
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
    const { default: init } = await importFresh("./cli/commands/init.mjs");
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
    const { default: init } = await importFresh("./cli/commands/init.mjs");
    await init({ statePath: dir, flags: { force: true }, projectDir: dir });
    const after = await readState(dir);
    assert.equal(after.plugins, undefined);
    assert.deepEqual(after.nodes, {});
  } finally {
    await rmTempProject(dir);
  }
});

test("init --force on a state with corrupt JSON (cannot read) does not crash and writes emptyState()", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, { version: 4, nodes: {}, edges: [], initiatives: {}, log: [] });
    // Corrupt the state file directly.
    await fsp_writeFile(stateFilePath(dir), "{ not valid json");
    const { default: init } = await importFresh("./cli/commands/init.mjs");
    // Should not throw; init --force is allowed on a corrupt state file.
    const out = await init({ statePath: dir, flags: { force: true }, projectDir: dir });
    assert.equal(out.ok, true);
    const after = await readState(dir);
    assert.equal(after.version, 1);
    assert.equal(after.revision, 1);
    assert.equal(after.plugins, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
