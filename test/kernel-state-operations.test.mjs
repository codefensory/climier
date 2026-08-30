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
  const { snapshotDir } = await importFresh("./state.mjs");
  return snapshotDir(projectDir);
}

const baseState = () => ({ version: 2, nodes: {}, edges: [], initiatives: {}, log: [] });

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
    const { createSnapshot } = await importFresh("./state.mjs");
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
