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

const baseState = () => ({ version: 3, nodes: {}, edges: [], initiatives: {}, log: [] });

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

test("kernel state.restore migrates a v2 snapshot to v3 before writing it", async () => {
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
    assert.equal(restored.version, 3);
    assert.deepEqual(restored.nodes.legacy, legacy.nodes.legacy);
    assert.equal(restored.log.at(-1).snapshot_id, target.id);
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
  for (const version of [1, 4]) {
    const dir = await createTempProject();
    try {
      const { initState } = await importFresh("./kernel/state-operations.mjs");
      const raw = JSON.stringify({ version, legacy: true });
      await fs.mkdir(path.dirname(stateFilePath(dir)), { recursive: true });
      await fs.writeFile(stateFilePath(dir), raw, "utf8");
      const out = await initState({ projectDir: dir, force: true, actor: "alice" });
      assert.equal((await readState(dir)).version, 3);
      assert.equal(out.result.snapshot.reason, "force-init");
      const files = await fs.readdir(await snapshotDir(dir));
      const snapshotId = files.find((name) => name.endsWith(".json") && !name.endsWith(".meta.json"));
      assert.ok(snapshotId);
      assert.equal(await fs.readFile(path.join(await snapshotDir(dir), snapshotId), "utf8"), raw);
    } finally { await rmTempProject(dir); }
  }
});

test("kernel state.restore recovers over v1 and future current state, preserving raw pre-restore snapshot", async () => {
  for (const version of [1, 4]) {
    const dir = await createTempProject();
    try {
      const { initState, restoreState } = await importFresh("./kernel/state-operations.mjs");
      const { createSnapshot, listSnapshots } = await importFresh("./storage/state.mjs");
      await initState({ projectDir: dir });
      const target = await createSnapshot(dir, "force-init");
      const raw = JSON.stringify({ version, legacy: true });
      await fs.writeFile(stateFilePath(dir), raw, "utf8");
      const out = await restoreState({ projectDir: dir, snapshotId: target.id, actor: "recovery" });
      assert.equal(out.result.snapshot.id, target.id);
      assert.equal((await readState(dir)).version, 3);
      assert.equal((await readState(dir)).log.at(-1).snapshot_id, target.id);
      const preRestore = (await listSnapshots(dir)).find((item) => item.reason === "pre-restore");
      assert.ok(preRestore);
      assert.equal(await fs.readFile(path.join(await snapshotDir(dir), `${preRestore.id}.json`), "utf8"), raw);
    } finally { await rmTempProject(dir); }
  }
});

test("kernel ordinary providers reject v1/future state while trusted init keeps version errors recoverable", async () => {
  for (const version of [1, 4]) {
    const dir = await createTempProject();
    try {
      const { mutate } = await importFresh("./kernel/mutate.mjs");
      const { initState } = await importFresh("./kernel/state-operations.mjs");
      const raw = JSON.stringify({ version, legacy: true });
      await fs.mkdir(path.dirname(stateFilePath(dir)), { recursive: true });
      await fs.writeFile(stateFilePath(dir), raw, "utf8");
      let prepareCalls = 0;
      await assert.rejects(
        () => mutate({
          projectDir: dir,
          request: { action: "task.create", actor: "alice", input: {} },
          provider: {
            prepare: async () => { prepareCalls += 1; return { target: { id: "T1" } }; },
            apply: async () => ({}),
          },
        }),
        (err) => err.code === (version === 1 ? "STATE_V1_UNSUPPORTED" : "CLIMIER_INCOMPATIBLE_VERSION"),
      );
      assert.equal(prepareCalls, 0);
      assert.equal(await fs.readFile(stateFilePath(dir), "utf8"), raw);
      await assert.rejects(
        () => initState({ projectDir: dir, actor: "alice" }),
        (err) => err.code === (version === 1 ? "STATE_V1_UNSUPPORTED" : "CLIMIER_INCOMPATIBLE_VERSION"),
      );
    } finally { await rmTempProject(dir); }
  }
});
