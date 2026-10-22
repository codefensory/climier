import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeCanonicalState,
  readState as readStateRaw,
  stateFilePath,
} from "./helpers.ts";

type NodeRecord = { id: string; kind: string; subkind?: string; status?: string; [key: string]: unknown };
type State = { version: number; revision: number; nodes: Record<string, NodeRecord>; edges: unknown[]; initiatives: Record<string, unknown>; log: Array<Record<string, unknown>>; plugins?: Record<string, unknown> };
type OperationResult = { result: { seeded?: unknown; snapshot: { id: string; reason: string } } };
type ErrorLike = { code?: string; message?: string };
function errorLike(error: unknown): ErrorLike {
  return (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
}
function readState(projectDir: string): Promise<State> {
  return readStateRaw(projectDir) as Promise<State>;
}

async function snapshotDir(projectDir: string) {
  const { snapshotDir: getSnapshotDir } = await importFresh("./storage/state.ts");
  return getSnapshotDir(projectDir);
}

const baseState = (): State => ({ version: 1, revision: 0, nodes: {}, edges: [], initiatives: {}, log: [] });

test("kernel state.init bootstraps an absent state through the kernel", async () => {
  const dir = await createTempProject();
  try {
    const { initState } = await importFresh("./kernel/state-operations.ts");
    const out: OperationResult = await initState({ projectDir: dir });
    assert.equal(out.result.seeded, null);
    const state = await readState(dir);
    assert.equal(state.version, 1);
    assert.ok(Number.isInteger(state.revision) && state.revision >= 1);
    assert.deepEqual(state.nodes, {});
    assert.deepEqual(state.edges, []);
    assert.deepEqual(state.initiatives, {});
    assert.deepEqual(state.log, []);
  } finally { await rmTempProject(dir); }
});

test("kernel state.init_force rejects policy before snapshot or write", async () => {
  const dir = await createTempProject();
  try {
    const { initState } = await importFresh("./kernel/state-operations.ts");
    const original = baseState();
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await writeCanonicalState(dir, original);
    const before = await readState(dir);
    await assert.rejects(
      () => initState({
        projectDir: dir,
        force: true,
        actor: "alice",
        policyAction: { decide: async () => ({ decision: "deny", reason: "no" }) },
      }),
      (err) => errorLike(err).code === "POLICY_DENIED",
    );
    assert.deepEqual(await readState(dir), before);
    assert.deepEqual(await fs.readdir(await snapshotDir(dir)).catch(() => []), []);
  } finally { await rmTempProject(dir); }
});

test("kernel state.init_force snapshots and resets while preserving root plugins", async () => {
  const dir = await createTempProject();
  try {
    const { initState } = await importFresh("./kernel/state-operations.ts");
    const original = baseState();
    original.plugins = { demo: { enabled: true } };
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await writeCanonicalState(dir, original);
    const out: OperationResult = await initState({ projectDir: dir, force: true, actor: "alice" });
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
    const { initState, restoreState } = await importFresh("./kernel/state-operations.ts");
    const original = baseState();
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await initState({ projectDir: dir });
    await writeCanonicalState(dir, original);
    const { createSnapshot } = await importFresh("./storage/state.ts");
    const target = await createSnapshot(dir, "force-init");
    await initState({ projectDir: dir, force: true, actor: "alice" });
    const out: OperationResult = await restoreState({ projectDir: dir, snapshotId: target.id, actor: "recovery" });
    const restored = await readState(dir);
    assert.ok(restored.nodes.keep);
    const lastLog = restored.log.at(-1)!;
    assert.equal(lastLog.action, "restore");
    assert.equal(lastLog.snapshot_id, target.id);
    assert.equal(out.result.snapshot.id, target.id);
    const entries = await fs.readdir(await snapshotDir(dir));
    assert.equal(entries.filter((name) => name.endsWith(".meta.json")).length, 3);
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore rejects a historical v2 snapshot with recovery guidance", async () => {
  const dir = await createTempProject();
  try {
    const { restoreState } = await importFresh("./kernel/state-operations.ts");
    const { snapshotDir: getSnapshotDir } = await importFresh("./storage/state.ts");
    const legacy = {
      version: 2,
      nodes: { legacy: { id: "legacy", kind: "resolvable", subkind: "task", status: "open" } },
      edges: [],
      initiatives: {},
      log: [{ action: "legacy" }],
    };
    await writeCanonicalState(dir, baseState());
    const snapshotDirectory = await getSnapshotDir(dir);
    await fs.mkdir(snapshotDirectory, { recursive: true });
    await fs.writeFile(path.join(snapshotDirectory, "legacy-v2.json"), JSON.stringify(legacy), "utf8");
    await fs.writeFile(path.join(snapshotDirectory, "legacy-v2.meta.json"), JSON.stringify({ id: "legacy-v2" }), "utf8");

    await assert.rejects(
      () => restoreState({ projectDir: dir, snapshotId: "legacy-v2", actor: "recovery" }),
      (err) => (errorLike(err).message ?? "").includes("legacy-v2")
        && /canonical v1/.test(errorLike(err).message ?? "")
        && /restore a verified backup/.test(errorLike(err).message ?? ""),
    );
  } finally { await rmTempProject(dir); }
});

// oxlint-disable-next-line max-statements -- Keep this bounded regression test and its full assertions intact.
test("kernel state.restore installs a canonical snapshot through SQLite", async () => {
  const dir = await createTempProject();
  try {
    const { initState, restoreState } = await importFresh("./kernel/state-operations.ts");
    const { createSnapshot } = await importFresh("./storage/state.ts");
    const { readState: readStoredState } = await importFresh("./storage/state.ts");
    const original = baseState();
    original.nodes.keep = { id: "keep", kind: "resolvable", subkind: "task", status: "open" };
    await writeCanonicalState(dir, original);
    const target = await createSnapshot(dir, "force-init");
    const targetRaw = JSON.parse(await fs.readFile(path.join(await snapshotDir(dir), `${target.id}.json`), "utf8"));
    assert.equal(targetRaw.version, 1);

    await initState({ projectDir: dir, force: true, actor: "alice" });
    const restored = await restoreState({ projectDir: dir, snapshotId: target.id, actor: "recovery" });
    const current = await readStoredState(dir);
    assert.ok(current.nodes.keep);
    assert.equal(current.version, 1);
    assert.equal(restored.result.snapshot.id, target.id);
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore rejects malformed v5 snapshot before policy or pre-snapshot", async () => {
  const dir = await createTempProject();
  try {
    const { restoreState } = await importFresh("./kernel/state-operations.ts");
    await writeCanonicalState(dir, baseState());
    const dirPath = await snapshotDir(dir);
    await fs.mkdir(dirPath, { recursive: true });
    const malformed = { version: 5, nodes: {}, edges: [], initiatives: {}, log: [] };
    await fs.writeFile(path.join(dirPath, "bad-v5.json"), JSON.stringify(malformed));
    await fs.writeFile(path.join(dirPath, "bad-v5.meta.json"), JSON.stringify({ id: "bad-v5" }));
    let policyCalls = 0;
    const before = await readState(dir);
    await assert.rejects(
      () => restoreState({
        projectDir: dir,
        snapshotId: "bad-v5",
        actor: "alice",
        policyAction: { decide: async () => { policyCalls += 1; return { decision: "allow" }; } },
      }),
      (err) => errorLike(err).code === "INVALID_STATUS",
    );
    assert.equal(policyCalls, 0);
    assert.deepEqual(await readState(dir), before);
    assert.deepEqual((await fs.readdir(dirPath)).toSorted(), ["bad-v5.json", "bad-v5.meta.json"]);
  } finally { await rmTempProject(dir); }
});

test("kernel state.restore rejects malformed target without writing or snapshotting", async () => {
  const dir = await createTempProject();
  try {
    const { restoreState } = await importFresh("./kernel/state-operations.ts");
    await writeCanonicalState(dir, baseState());
    const dirPath = await snapshotDir(dir);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, "bad.json"), "not json");
    await fs.writeFile(path.join(dirPath, "bad.meta.json"), JSON.stringify({ id: "bad" }));
    const before = await readState(dir);
    await assert.rejects(() => restoreState({ projectDir: dir, snapshotId: "bad", actor: "alice" }), (err) => errorLike(err).code === "INVALID_STATUS");
    assert.deepEqual(await readState(dir), before);
    assert.deepEqual((await fs.readdir(dirPath)).toSorted(), ["bad.json", "bad.meta.json"]);
  } finally { await rmTempProject(dir); }
});

