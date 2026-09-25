import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState,
  readState,
  stateFilePath,
} from "./helpers.mjs";

async function snapshotDir(projectDir) {
  const { snapshotDir } = await importFresh("./storage/state.mjs");
  return snapshotDir(projectDir);
}

const baseState = () => ({ version: 4, revision: 0, nodes: {}, edges: [], initiatives: {}, log: [] });

test("kernel state.init bootstraps an absent state through the kernel", async () => {
  const dir = await createTempProject();
  try {
    const { initState } = await importFresh("./kernel/state-operations.mjs");
    const out = await initState({ projectDir: dir });
    assert.equal(out.result.seeded, null);
    assert.deepEqual(await readState(dir), baseState());
  } finally { await rmTempProject(dir); }
});

test("kernel state.init_force rejects policy before snapshot or write", async () => {
  const dir = await createTempProject();
  try {
    const { initState } = await importFresh("./kernel/state-operations.mjs");
    const original = baseState();
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await writeState(dir, original);
    const before = await fs.readFile(stateFilePath(dir), "utf8");
    await assert.rejects(
      () => initState({
        projectDir: dir,
        force: true,
        actor: "alice",
        policyAction: { decide: async () => ({ decision: "deny", reason: "no" }) },
      }),
      (err) => err.code === "POLICY_DENIED",
    );
    assert.equal(await fs.readFile(stateFilePath(dir), "utf8"), before);
    assert.deepEqual(await fs.readdir(await snapshotDir(dir)).catch(() => []), []);
  } finally { await rmTempProject(dir); }
});

test("kernel state.init_force snapshots and resets while preserving root plugins", async () => {
  const dir = await createTempProject();
  try {
    const { initState } = await importFresh("./kernel/state-operations.mjs");
    const original = baseState();
    original.plugins = { demo: { enabled: true } };
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await writeState(dir, original);
    const out = await initState({ projectDir: dir, force: true, actor: "alice" });
    const state = await readState(dir);
    assert.deepEqual(state.nodes, {});
    assert.deepEqual(state.plugins, original.plugins);
    assert.equal(out.result.snapshot.reason, "force-init");
    const entries = await fs.readdir(await snapshotDir(dir));
    assert.equal(entries.filter((name) => name.endsWith(".meta.json")).length, 1);
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore validates before pre-snapshot and restores with one log entry", async () => {
  const dir = await createTempProject();
  try {
    const { initState, restoreState } = await importFresh("./kernel/state-operations.mjs");
    const original = baseState();
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await writeState(dir, original);
    const { createSnapshot } = await importFresh("./storage/state.mjs");
    const target = await createSnapshot(dir, "force-init");
    await initState({ projectDir: dir, force: true, actor: "alice" });
    const out = await restoreState({ projectDir: dir, snapshotId: target.id, actor: "recovery" });
    const restored = await readState(dir);
    assert.ok(restored.nodes.keep);
    assert.equal(restored.log.at(-1).action, "restore");
    assert.equal(restored.log.at(-1).snapshot_id, target.id);
    assert.equal(out.result.snapshot.id, target.id);
    const entries = await fs.readdir(await snapshotDir(dir));
    assert.equal(entries.filter((name) => name.endsWith(".meta.json")).length, 3);
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore migrates a v2 snapshot to v4 before writing it", async () => {
  const dir = await createTempProject();
  try {
    const { restoreState } = await importFresh("./kernel/state-operations.mjs");
    const { createSnapshot } = await importFresh("./storage/state.mjs");
    const legacy = {
      version: 2,
      nodes: { legacy: { id: "legacy", kind: "resolvable", subkind: "task", status: "open" } },
      edges: [],
      initiatives: {},
      log: [{ action: "legacy" }],
    };
    await fs.mkdir(path.dirname(stateFilePath(dir)), { recursive: true });
    await fs.writeFile(stateFilePath(dir), JSON.stringify(legacy), "utf8");
    const target = await createSnapshot(dir, "force-init");
    await writeState(dir, baseState());

    const out = await restoreState({ projectDir: dir, snapshotId: target.id, actor: "recovery" });
    const restored = await readState(dir);
    assert.equal(out.result.snapshot.id, target.id);
    assert.equal(restored.version, 4);
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.nodes.legacy, legacy.nodes.legacy);
    assert.equal(restored.log.at(-1).snapshot_id, target.id);
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore replaces a valid v5 snapshot through the fenced state path", async () => {
  const dir = await createTempProject();
  try {
    const { initState, restoreState } = await importFresh("./kernel/state-operations.mjs");
    const { createSnapshot } = await importFresh("./storage/state.mjs");
    const { bootstrapFencedState, readFencedState } = await importFresh("./storage/ledger.mjs");
    const original = baseState();
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await writeState(dir, original);
    await bootstrapFencedState(dir);
    const target = await createSnapshot(dir, "force-init");
    const targetRaw = JSON.parse(await fs.readFile(path.join(await snapshotDir(dir), `${target.id}.json`), "utf8"));
    assert.equal(targetRaw.version, 5);
    assert.ok(Number.isInteger(targetRaw.fence_generation));

    await initState({ projectDir: dir, force: true, actor: "alice" });
    const out = await restoreState({ projectDir: dir, snapshotId: target.id, actor: "recovery" });
    const restored = await readFencedState(dir);
    assert.equal(out.result.snapshot.id, target.id);
    assert.ok(restored.nodes.keep);
    assert.equal(restored.version, 5);
    assert.equal(restored.fence_generation, targetRaw.fence_generation);
    assert.equal(restored.log.at(-1).action, "restore");
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore rejects malformed v5 snapshot before policy or pre-snapshot", async () => {
  const dir = await createTempProject();
  try {
    const { restoreState } = await importFresh("./kernel/state-operations.mjs");
    const { bootstrapFencedState } = await importFresh("./storage/ledger.mjs");
    await writeState(dir, baseState());
    await bootstrapFencedState(dir);
    const dirPath = await snapshotDir(dir);
    await fs.mkdir(dirPath, { recursive: true });
    const malformed = { version: 5, fence_generation: 1.5, nodes: {}, edges: [], initiatives: {}, log: [] };
    await fs.writeFile(path.join(dirPath, "bad-v5.json"), JSON.stringify(malformed));
    await fs.writeFile(path.join(dirPath, "bad-v5.meta.json"), JSON.stringify({ id: "bad-v5" }));
    let policyCalls = 0;
    const before = await fs.readFile(stateFilePath(dir), "utf8");
    await assert.rejects(
      () => restoreState({
        projectDir: dir,
        snapshotId: "bad-v5",
        actor: "alice",
        policyAction: { decide: async () => { policyCalls += 1; return { decision: "allow" }; } },
      }),
      (err) => err.code === "INVALID_STATUS",
    );
    assert.equal(policyCalls, 0);
    assert.equal(await fs.readFile(stateFilePath(dir), "utf8"), before);
    assert.deepEqual((await fs.readdir(dirPath)).sort(), ["bad-v5.json", "bad-v5.meta.json"]);
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore rejects malformed target without writing or snapshotting", async () => {
  const dir = await createTempProject();
  try {
    const { restoreState } = await importFresh("./kernel/state-operations.mjs");
    await writeState(dir, baseState());
    const dirPath = await snapshotDir(dir);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, "bad.json"), "not json");
    await fs.writeFile(path.join(dirPath, "bad.meta.json"), JSON.stringify({ id: "bad" }));
    const before = await fs.readFile(stateFilePath(dir), "utf8");
    await assert.rejects(() => restoreState({ projectDir: dir, snapshotId: "bad", actor: "alice" }), (err) => err.code === "INVALID_STATUS");
    assert.equal(await fs.readFile(stateFilePath(dir), "utf8"), before);
    assert.deepEqual(await fs.readdir(dirPath), ["bad.json", "bad.meta.json"]);
  } finally { await rmTempProject(dir); }
});

test("kernel state.init_force recovers v1 and future state by snapshotting raw bytes", async () => {
  for (const version of [1, 6]) {
    const dir = await createTempProject();
    try {
      const { initState } = await importFresh("./kernel/state-operations.mjs");
      const raw = JSON.stringify(version === 5
        ? { version, nodes: {}, edges: [], initiatives: {}, log: [] }
        : { version, legacy: true });
      await fs.mkdir(path.dirname(stateFilePath(dir)), { recursive: true });
      await fs.writeFile(stateFilePath(dir), raw, "utf8");
      const out = await initState({ projectDir: dir, force: true, actor: "alice" });
      assert.equal((await readState(dir)).version, 4);
      assert.equal(out.result.snapshot.reason, "force-init");
      const files = await fs.readdir(await snapshotDir(dir));
      const snapshotId = files.find((name) => name.endsWith(".json") && !name.endsWith(".meta.json"));
      assert.ok(snapshotId);
      assert.equal(await fs.readFile(path.join(await snapshotDir(dir), snapshotId), "utf8"), raw);
    } finally { await rmTempProject(dir); }
  }
});

test("kernel state.restore recovers over v1 and future current state, preserving raw pre-restore snapshot", async () => {
  for (const version of [1, 6]) {
    const dir = await createTempProject();
    try {
      const { initState, restoreState } = await importFresh("./kernel/state-operations.mjs");
      const { createSnapshot, listSnapshots } = await importFresh("./storage/state.mjs");
      await initState({ projectDir: dir });
      const target = await createSnapshot(dir, "force-init");
      const raw = JSON.stringify(version === 5
        ? { version, nodes: {}, edges: [], initiatives: {}, log: [] }
        : { version, legacy: true });
      await fs.writeFile(stateFilePath(dir), raw, "utf8");
      const out = await restoreState({ projectDir: dir, snapshotId: target.id, actor: "recovery" });
      assert.equal(out.result.snapshot.id, target.id);
      assert.equal((await readState(dir)).version, 4);
      assert.equal((await readState(dir)).log.at(-1).snapshot_id, target.id);
      const preRestore = (await listSnapshots(dir)).find((item) => item.reason === "pre-restore");
      assert.ok(preRestore);
      assert.equal(await fs.readFile(path.join(await snapshotDir(dir), `${preRestore.id}.json`), "utf8"), raw);
    } finally { await rmTempProject(dir); }
  }
});

test("kernel state.init recovers corrupt bytes through an existing fenced ledger without policy or actor", async () => {
  const dir = await createTempProject();
  try {
    const { initState } = await importFresh("./kernel/state-operations.mjs");
    const { bootstrapFencedState, readFencedState, ledgerFile } = await importFresh("./storage/ledger.mjs");
    await writeState(dir, baseState());
    await bootstrapFencedState(dir);
    const ledgerPath = ledgerFile(dir);
    const beforeLedger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    const corruptRaw = Buffer.from("{ corrupt fenced state\n");
    await fs.writeFile(stateFilePath(dir), corruptRaw);
    let policyCalls = 0;

    const out = await initState({
      projectDir: dir,
      policyAction: { decide: async () => { policyCalls += 1; return { decision: "deny" }; } },
    });

    const state = await readFencedState(dir);
    const afterLedger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.deepEqual(state.nodes, {});
    assert.equal(state.version, 5);
    assert.ok(state.revision > beforeLedger.high_water_revision);
    assert.equal(afterLedger.high_water_revision, state.revision);
    assert.equal(state.fence_generation, beforeLedger.fence_generation);
    assert.equal(policyCalls, 0);
    assert.equal(out.result.snapshot.reason, "corrupt-recovery");
    const snapPath = path.join(await snapshotDir(dir), `${out.result.snapshot.id}.json`);
    assert.deepEqual(await fs.readFile(snapPath), corruptRaw);
  } finally { await rmTempProject(dir); }
});

test("kernel ordinary providers reject v1/future state while trusted init keeps version errors recoverable", async () => {
  for (const version of [1, 6]) {
    const dir = await createTempProject();
    try {
      const { mutate } = await importFresh("./kernel/mutate.mjs");
      const { initState } = await importFresh("./kernel/state-operations.mjs");
      const raw = JSON.stringify(version === 5
        ? { version, nodes: {}, edges: [], initiatives: {}, log: [] }
        : { version, legacy: true });
      await fs.mkdir(path.dirname(stateFilePath(dir)), { recursive: true });
      await fs.writeFile(stateFilePath(dir), raw, "utf8");
      let prepareCalls = 0;
      let policyCalls = 0;
      await assert.rejects(
        () => mutate({
          projectDir: dir,
          request: { action: "task.create", actor: "alice", input: {} },
          provider: {
            prepare: async () => { prepareCalls += 1; return { target: { id: "T1" } }; },
            apply: async () => ({}),
          },
          policyAction: { decide: async () => { policyCalls += 1; return { decision: "allow" }; } },
        }),
        (err) => err.code === (version === 1 ? "STATE_V1_UNSUPPORTED" : "CLIMIER_INCOMPATIBLE_VERSION"),
      );
      assert.equal(prepareCalls, 0);
      assert.equal(policyCalls, 0);
      assert.equal(await fs.readFile(stateFilePath(dir), "utf8"), raw);
      await assert.rejects(
        () => initState({ projectDir: dir, actor: "alice" }),
        (err) => err.code === (version === 1 ? "STATE_V1_UNSUPPORTED" : "CLIMIER_INCOMPATIBLE_VERSION"),
      );
    } finally { await rmTempProject(dir); }
  }
});
