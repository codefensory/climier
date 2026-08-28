// plugin-compat.test.mjs — T-plugin-state acceptance.
//
// Ensures that the additive plugin fields `plugins` (root) and
// `nodes[id].plugins` (per node) survive every core mutator, snapshot
// primitive, and restore. The `data.*.set` write pathway lives in
// T-plugin-api, so plugin data here is seeded manually. The DAG
// derivation must not consume these fields.
//
// Contract under test (ADR-005 §"API y persistencia" + §"Compatibilidad
// de estado v2"):
//   - `plugins` is additive and optional; version stays 2.
//   - writeState, updateState, init, init --force, add-node/add-task/
//     add-gate/add-knowledge, update, take, resolve, reopen, release,
//     cancel, snapshots, restore all preserve `plugins` and
//     `nodes[id].plugins`.
//   - The DAG (derive, statusOfV2, isSatisfiedV2) ignores these fields.
//
// The corpus lives in helpers.mjs (`createTempProject`, `importFresh`,
// `stateFilePath`, `runCli`) which always sets CLIMIER_HOME to a fresh
// temp dir; no real ~/.climier is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  stateFilePath,
  runCli,
  writeState,
  readState,
  installPolicyFixture,
  uninstallPolicyFixture,
} from "./helpers.mjs";

// =========================================================================
// Fixtures
// =========================================================================

function snapshotDir(dir) {
  return path.join(path.dirname(stateFilePath(dir)), "snapshots");
}

function baseState() {
  return {
    version: 2,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "T1",
        initiative: "p",
        domain: "auth",
        tags: ["audit"],
        resolution_mode: "labor",
        status: "open",
        revision: 1,
      },
      T2: {
        id: "T2",
        kind: "resolvable",
        subkind: "task",
        title: "T2",
        initiative: "p",
        domain: "auth",
        tags: ["audit"],
        resolution_mode: "labor",
        status: "open",
        revision: 1,
      },
    },
    edges: [],
    initiatives: { p: { desc: "plugin platform", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  };
}

// Seed the additive plugin fields. Each call adds distinct values so any
// preservation regression is visible (deepEqual catches accidental
// clearing or rewrites).
function seedPluginData(state) {
  state.plugins = {
    "example.audit": {
      data: { counter: 7, label: "audit run #7", nested: { ok: true } },
    },
    "example.metrics": {
      data: { count: 42 },
    },
  };
  if (state.nodes && state.nodes.T1) {
    state.nodes.T1.plugins = {
      "example.audit": { data: { perNode: "T1 audit" } },
    };
  }
  if (state.nodes && state.nodes.T2) {
    state.nodes.T2.plugins = {
      "example.audit": { data: { perNode: "T2 audit" } },
      "example.metrics": { data: { perNode: "T2 metrics" } },
    };
  }
}

async function bootstrapState(dir, mutate) {
  const base = baseState();
  if (typeof mutate === "function") mutate(base);
  await writeState(dir, base);
  return base;
}

// Assert the additive plugin fields are intact with the seeded values.
// Returns nothing; throws on regression.
function assertPluginDataPreserved(state) {
  assert.ok(state.plugins, "root `plugins` must be preserved");
  assert.deepEqual(state.plugins["example.audit"].data, {
    counter: 7,
    label: "audit run #7",
    nested: { ok: true },
  });
  assert.deepEqual(state.plugins["example.metrics"].data, { count: 42 });
  if (state.nodes && state.nodes.T1) {
    assert.ok(state.nodes.T1.plugins, "T1.plugins must be preserved");
    assert.deepEqual(state.nodes.T1.plugins["example.audit"].data, { perNode: "T1 audit" });
  }
  if (state.nodes && state.nodes.T2) {
    assert.ok(state.nodes.T2.plugins, "T2.plugins must be preserved");
    assert.deepEqual(state.nodes.T2.plugins["example.audit"].data, { perNode: "T2 audit" });
    assert.deepEqual(state.nodes.T2.plugins["example.metrics"].data, { perNode: "T2 metrics" });
  }
}

// =========================================================================
// writeState / updateState round-trip
// =========================================================================

test("writeState preserves `plugins` (root) and `nodes[id].plugins` on round-trip", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("updateState preserves `plugins` (root) and `nodes[id].plugins` when a mutator touches a node", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { updateState } = await importFresh("./state.mjs");
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

test("updateState preserves `plugins` (root) when a mutator touches an unrelated collection (edges)", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { updateState } = await importFresh("./state.mjs");
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

// =========================================================================
// init / init --force
// =========================================================================

test("init on a fresh project writes emptyState() without `plugins` (plugins is optional)", async () => {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./commands/init.mjs");
    const out = await init({ statePath: dir, flags: {}, projectDir: dir });
    assert.equal(out.ok, true);
    const after = await readState(dir);
    assert.equal(after.version, 2);
    assert.equal(after.plugins, undefined, "fresh emptyState() must not carry a `plugins` field");
  } finally {
    await rmTempProject(dir);
  }
});

test("init --force preserves root `plugins` (nodes are wiped, root plugins survive)", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: init } = await importFresh("./commands/init.mjs");
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
    await bootstrapState(dir);
    const { default: init } = await importFresh("./commands/init.mjs");
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
    await bootstrapState(dir);
    // Corrupt the state file directly.
    await fsp_writeFile(stateFilePath(dir), "{ not valid json");
    const { default: init } = await importFresh("./commands/init.mjs");
    // Should not throw; init --force is allowed on a corrupt state file.
    const out = await init({ statePath: dir, flags: { force: true }, projectDir: dir });
    assert.equal(out.ok, true);
    const after = await readState(dir);
    assert.equal(after.version, 2);
    assert.equal(after.plugins, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// Per-mutator preservation (root plugins + per-node plugins)
// =========================================================================

test("add-task preserves root plugins and existing per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");
    await addTask({
      statePath: dir,
      projectDir: dir,
      positional: ["T3"],
      flags: {
        initiative: "p",
        title: "T3",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    // New node T3 has no plugins (it was just created).
    assert.equal(after.nodes.T3.plugins, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gate preserves root plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: addGate } = await importFresh("./commands/add-gate.mjs");
    await addGate({
      statePath: dir,
      projectDir: dir,
      positional: ["G1"],
      flags: {
        initiative: "p",
        title: "G1",
        body: "b",
        purpose: "decision",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-knowledge preserves root plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: addKnowledge } = await importFresh("./commands/add-knowledge.mjs");
    await addKnowledge({
      statePath: dir,
      projectDir: dir,
      positional: ["K1"],
      flags: {
        initiative: "p",
        title: "K1",
        body: "b",
        "scope-tags": "audit",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("update preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: update } = await importFresh("./commands/update.mjs");
    await update({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: {
        title: "T1 (updated)",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.title, "T1 (updated)");
  } finally {
    await rmTempProject(dir);
  }
});

test("take preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "in_progress");
    assert.equal(after.nodes.T1.claim.by, "tester");
  } finally {
    await rmTempProject(dir);
  }
});

test("resolve (task) preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const { default: resolve } = await importFresh("./commands/resolve.mjs");
    await resolve({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester", note: "done" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "done");
    assert.equal(after.nodes.T1.done_by, "tester");
  } finally {
    await rmTempProject(dir);
  }
});

test("resolve (gate) preserves root plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes.G1 = {
        id: "G1",
        kind: "resolvable",
        subkind: "gate",
        title: "G1",
        initiative: "p",
        status: "open",
        revision: 1,
        purpose: "decision",
      };
      delete s.nodes.T1;
      delete s.nodes.T2;
    });
    seedPluginData(base);
    await writeState(dir, base);
    const { default: resolve } = await importFresh("./commands/resolve.mjs");
    await resolve({
      statePath: dir,
      projectDir: dir,
      positional: ["G1"],
      flags: { as: "tester", choice: "yes", rationale: "because" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.G1.status, "resolved");
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const { default: resolve } = await importFresh("./commands/resolve.mjs");
    await resolve({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester", note: "done" },
    });
    const { default: reopen } = await importFresh("./commands/reopen.mjs");
    await reopen({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester", reason: "rollback" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "open");
  } finally {
    await rmTempProject(dir);
  }
});

test("release preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const { default: release } = await importFresh("./commands/release.mjs");
    await release({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "open");
    assert.equal(after.nodes.T1.claim, null);
  } finally {
    await rmTempProject(dir);
  }
});

test("cancel preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  await installPolicyFixture(dir);
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    // Use a policy-allow actor so we can cancel an unclaimed open task;
    // the preservation contract is independent of the authority rule and
    // is exercised separately elsewhere.
    const { default: cancel } = await importFresh("./commands/cancel.mjs");
    await cancel({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "release-manager", reason: "abandoned" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "canceled");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

// =========================================================================
// Snapshot primitives + restore preserve plugins and per-node plugins
// =========================================================================

test("createSnapshot preserves `plugins` and `nodes[id].plugins` in raw bytes", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { createSnapshot } = await importFresh("./state.mjs");
    const meta = await createSnapshot(dir, "force-init");
    const rawBytes = await fs.readFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      "utf8",
    );
    const parsed = JSON.parse(rawBytes);
    assertPluginDataPreserved(parsed);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots is unaffected by plugin data (metadata contract unchanged)", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { createSnapshot, listSnapshots } = await importFresh("./state.mjs");
    const meta = await createSnapshot(dir, "force-init");
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].id, meta.id);
    assert.equal(snaps[0].reason, "force-init");
    assert.equal(typeof snaps[0].bytes, "number");
    assert.equal(typeof snaps[0].sha256, "string");
    // Metadata does NOT leak plugin data.
    assert.equal(snaps[0].plugins, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore preserves `plugins` and `nodes[id].plugins` from the snapshot raw bytes", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const meta = await createSnapshot(dir, "force-init");
    // Wipe the state to a different shape (no plugins).
    await writeState(dir, {
      version: 2,
      nodes: {},
      edges: [],
      initiatives: {},
      log: [],
    });
    const out = await restore({
      statePath: dir,
      projectDir: dir,
      positional: [meta.id],
      flags: { as: "orchestrator" },
    });
    assert.ok(out.snapshot);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("end-to-end: snapshot with plugin data survives restore, then take/resolve cycles preserve it", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const { default: take } = await importFresh("./commands/take.mjs");
    const { default: resolve } = await importFresh("./commands/resolve.mjs");
    const meta = await createSnapshot(dir, "force-init");
    await writeState(dir, { version: 2, nodes: {}, edges: [], initiatives: {}, log: [] });
    await restore({
      statePath: dir,
      projectDir: dir,
      positional: [meta.id],
      flags: { as: "orchestrator" },
    });
    // Now run the lifecycle on the restored state.
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    await resolve({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester", note: "done" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "done");
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// DAG derivation ignores plugins
// =========================================================================

test("deriveV2 does not consume `plugins` or `nodes[id].plugins` (ready/blocked unchanged)", async () => {
  const { deriveV2 } = await importFresh("./v2.mjs");
  const withoutPlugins = {
    version: 2,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", title: "T1", status: "open", revision: 1 },
      T2: { id: "T2", kind: "resolvable", subkind: "task", title: "T2", status: "open", revision: 1 },
      G1: { id: "G1", kind: "resolvable", subkind: "gate", title: "G1", status: "open", revision: 1 },
    },
    edges: [{ from: "G1", to: "T1", type: "BLOCKS" }],
    initiatives: {},
    log: [],
  };
  const withPlugins = JSON.parse(JSON.stringify(withoutPlugins));
  withPlugins.plugins = { "example.audit": { data: { counter: 7 } } };
  withPlugins.nodes.T1.plugins = { "example.audit": { data: { perNode: "T1" } } };
  withPlugins.nodes.T2.plugins = { "example.metrics": { data: { perNode: "T2" } } };
  // Adding the additive fields must not change derivation.
  const a = deriveV2(withoutPlugins);
  const b = deriveV2(withPlugins);
  assert.deepEqual(b.ready, a.ready);
  assert.deepEqual(b.blocked, a.blocked);
  assert.deepEqual(b.openGates, a.openGates);
  assert.deepEqual(b.backlog, a.backlog);
  // And the specific layout we expect.
  assert.deepEqual(b.ready, ["T2"]);
  assert.deepEqual(b.blocked, ["T1"]);
  assert.deepEqual(b.openGates, ["G1"]);
});

test("statusOfV2 does not consume `plugins` or `nodes[id].plugins`", async () => {
  const { statusOfV2 } = await importFresh("./v2.mjs");
  const node = {
    id: "T1",
    kind: "resolvable",
    subkind: "task",
    title: "T1",
    status: "open",
    revision: 1,
    plugins: { "example.audit": { data: { foo: "bar" } } },
  };
  const state = {
    version: 2,
    plugins: { "example.audit": { data: { foo: "bar" } } },
    nodes: { T1: node },
    edges: [],
    initiatives: {},
    log: [],
  };
  assert.equal(statusOfV2(state, "T1"), "ready");
});

test("isSatisfiedV2 does not consume `nodes[id].plugins`", async () => {
  const { isSatisfiedV2 } = await importFresh("./v2.mjs");
  const done = {
    id: "T1",
    kind: "resolvable",
    subkind: "task",
    title: "T1",
    status: "done",
    revision: 1,
    plugins: { "example.audit": { data: { perNode: "T1" } } },
  };
  const state = {
    version: 2,
    plugins: {},
    nodes: { T1: done },
    edges: [],
    initiatives: {},
    log: [],
  };
  assert.equal(isSatisfiedV2(state, "T1"), true);
});

// =========================================================================
// meta and nodes[id].plugins are disjoint keyspaces
// =========================================================================

test("`meta` and `nodes[id].plugins` survive take together (disjoint keyspaces)", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes.T1.meta = {
        execution: { effort: "S", risk: "low", checks: ["npm test"] },
      };
      s.nodes.T1.plugins = { "example.audit": { data: { x: 1 } } };
    });
    await writeState(dir, base);
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const after = await readState(dir);
    assert.deepEqual(after.nodes.T1.meta, {
      execution: { effort: "S", risk: "low", checks: ["npm test"] },
    });
    assert.deepEqual(after.nodes.T1.plugins, { "example.audit": { data: { x: 1 } } });
  } finally {
    await rmTempProject(dir);
  }
});

test("`meta` and `nodes[id].plugins` survive resolve (task) together", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes.T1.meta = { execution: { effort: "M", risk: "integration", checks: ["npm test"] } };
      s.nodes.T1.plugins = { "example.audit": { data: { x: 2 } } };
    });
    await writeState(dir, base);
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const { default: resolve } = await importFresh("./commands/resolve.mjs");
    await resolve({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester", note: "done" },
    });
    const after = await readState(dir);
    assert.deepEqual(after.nodes.T1.meta, {
      execution: { effort: "M", risk: "integration", checks: ["npm test"] },
    });
    assert.deepEqual(after.nodes.T1.plugins, { "example.audit": { data: { x: 2 } } });
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// CLI dispatch via bin
// =========================================================================

test("CLI: init --force preserves root plugins via bin", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const r = await runCli(["--project", dir, "init", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: snapshot + restore preserves plugin data via bin", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    r = await runCli(["--project", dir, "init", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    const list = await runCli(["--project", dir, "snapshots"]);
    const { snapshots } = JSON.parse(list.stdout);
    const targetId = snapshots[0].id;
    // Wipe the state to a no-plugins shape.
    await writeState(dir, {
      version: 2,
      nodes: {},
      edges: [],
      initiatives: {},
      log: [],
    });
    r = await runCli(["--project", dir, "restore", targetId, "--as", "orchestrator"]);
    assert.equal(r.code, 0, r.stderr);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// Internal helper for the corrupt-JSON case
// =========================================================================

async function fsp_writeFile(p, contents) {
  await fs.writeFile(p, contents);
}