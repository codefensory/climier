// state-snapshots.test.mjs — primitives de snapshot raw + metadata.
//
// Cubre ADR-004 §§Snapshots/Plan 1: storage primitives debajo del lock
// existente, y la integración con `init --force` (force-init) y el recovery
// de JSON corrupto (corrupt-recovery). El comando `snapshots` y el
// comando `restore` llegan en pasos posteriores.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, stateFilePath } from "./helpers.mjs";

const SNAPSHOT_ID_PATTERN = /^(\d{8}T\d{9}Z)-(force-init|corrupt-recovery|pre-restore)-([0-9a-f]{8})$/;

function snapshotDir(dir) {
  return path.join(path.dirname(stateFilePath(dir)), "snapshots");
}

function rawReadback(dir, id) {
  return fs.readFile(path.join(snapshotDir(dir), `${id}.json`));
}

async function bootstrapState(dir, mutate) {
  const { writeState } = await importFresh("./storage/state.mjs");
  const base = { version: 3, nodes: {}, edges: [], initiatives: {}, log: [] };
  if (typeof mutate === "function") mutate(base);
  await writeState(dir, base);
  return base;
}

// =====================================================================
// Snapshot creation primitives
// =====================================================================

test("createSnapshot: writes raw + metadata files under <state-dir>/snapshots", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes["T1"] = { id: "T1", title: "x" };
      s.initiatives.auth = { desc: "auth", created_at: "2026-01-01T00:00:00.000Z" };
    });
    const meta = await createSnapshot(dir, "force-init");
    // Raw file exists with the exact bytes of the state file at snapshot time.
    const expectedRaw = Buffer.from(JSON.stringify(base, null, 2) + "\n", "utf8");
    const rawBytes = await rawReadback(dir, meta.id);
    assert.ok(rawBytes.equals(expectedRaw), "raw bytes must match the state file at snapshot time");
    // Metadata file exists and parses back to the returned meta.
    const metaBytes = await fs.readFile(path.join(snapshotDir(dir), `${meta.id}.meta.json`), "utf8");
    const metaParsed = JSON.parse(metaBytes);
    assert.deepEqual(metaParsed, meta);
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: metadata has id, created_at, reason, bytes, sha256 with correct values", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes["T1"] = { id: "T1", title: "x" };
    });
    const meta = await createSnapshot(dir, "force-init");
    assert.equal(typeof meta.id, "string");
    assert.equal(typeof meta.created_at, "string");
    assert.equal(meta.reason, "force-init");
    assert.equal(typeof meta.bytes, "number");
    assert.equal(typeof meta.sha256, "string");
    assert.equal(meta.sha256.length, 64);
    // bytes == raw file size.
    const expectedBytes = Buffer.byteLength(JSON.stringify(base, null, 2) + "\n", "utf8");
    assert.equal(meta.bytes, expectedBytes);
    // sha256 matches the raw bytes we just stored.
    const rawBytes = await rawReadback(dir, meta.id);
    const actualSha = crypto.createHash("sha256").update(rawBytes).digest("hex");
    assert.equal(meta.sha256, actualSha);
    // created_at is a parseable ISO timestamp.
    const ts = Date.parse(meta.created_at);
    assert.ok(!Number.isNaN(ts), `created_at must be a parseable timestamp; got ${meta.created_at}`);
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: id matches the ADR format <UTC YYYYMMDDTHHmmssSSS Z>-<reason>-<8 hex>", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    assert.match(meta.id, SNAPSHOT_ID_PATTERN);
    const m = meta.id.match(SNAPSHOT_ID_PATTERN);
    const year = parseInt(m[1].slice(0, 4), 10);
    assert.ok(year >= 2024 && year <= 2100, `expected plausible year; got ${year}`);
    assert.equal(m[2], "force-init");
    assert.match(m[3], /^[0-9a-f]{8}$/);
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: rejects unknown reason", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    await assert.rejects(() => createSnapshot(dir, "bogus-reason"), /invalid reason/i);
    await assert.rejects(() => createSnapshot(dir, "init"), /invalid reason/i);
    await assert.rejects(() => createSnapshot(dir, "force_init"), /invalid reason/i);
    await assert.rejects(() => createSnapshot(dir, ""), /invalid reason/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: accepts all three valid reasons", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    const m1 = await createSnapshot(dir, "force-init");
    const m2 = await createSnapshot(dir, "corrupt-recovery");
    const m3 = await createSnapshot(dir, "pre-restore");
    assert.equal(m1.reason, "force-init");
    assert.equal(m2.reason, "corrupt-recovery");
    assert.equal(m3.reason, "pre-restore");
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: uses temp+rename; no .tmp-* leftovers after success", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    const entries = await fs.readdir(snapshotDir(dir));
    const tmp = entries.filter((e) => e.includes(".tmp-"));
    assert.deepEqual(tmp, [], `expected no .tmp-* leftovers; got ${tmp.join(", ")}`);
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: snapshot dir perms 0700 on Unix (best-effort)", { skip: process.platform === "win32" }, async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    const dstat = await fs.stat(snapshotDir(dir));
    assert.equal(dstat.mode & 0o777, 0o700, `snapshot dir must be 0700; got 0o${(dstat.mode & 0o777).toString(8)}`);
    const rawStat = await fs.stat(path.join(snapshotDir(dir), `${meta.id}.json`));
    assert.equal(rawStat.mode & 0o777, 0o600, `raw must be 0600; got 0o${(rawStat.mode & 0o777).toString(8)}`);
    const metaStat = await fs.stat(path.join(snapshotDir(dir), `${meta.id}.meta.json`));
    assert.equal(metaStat.mode & 0o777, 0o600, `meta must be 0600; got 0o${(metaStat.mode & 0o777).toString(8)}`);
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: perms are best-effort on Windows (does not throw)", { skip: process.platform !== "win32" }, async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    // No assertion on mode: chmod is best-effort and the underlying syscall
    // is not portable. The contract is that createSnapshot must NOT throw.
    const meta = await createSnapshot(dir, "force-init");
    assert.equal(meta.reason, "force-init");
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: throws when the source state file is missing", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(() => createSnapshot(dir, "force-init"));
  } finally {
    await rmTempProject(dir);
  }
});

test("createSnapshot: preserves raw bytes verbatim for non-JSON content", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    // Bootstrap a v2 metadata first (so stateFile() resolves), then overwrite
    // the state file with raw non-JSON bytes.
    const { default: init } = await importFresh("./cli/commands/init.mjs");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const file = stateFilePath(dir);
    const garbage = "{ this is not JSON but it's raw and we keep it verbatim\n";
    await fs.writeFile(file, garbage);
    const meta = await createSnapshot(dir, "corrupt-recovery");
    const rawBytes = await rawReadback(dir, meta.id);
    assert.equal(rawBytes.toString("utf8"), garbage);
  } finally {
    await rmTempProject(dir);
  }
});

test("two snapshots taken back-to-back have different ids (random suffix)", async () => {
  const { createSnapshot } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    const m1 = await createSnapshot(dir, "force-init");
    const m2 = await createSnapshot(dir, "force-init");
    assert.notEqual(m1.id, m2.id);
  } finally {
    await rmTempProject(dir);
  }
});

// =====================================================================
// listSnapshots primitive
// =====================================================================

test("listSnapshots: returns [] when no snapshot dir exists", async () => {
  const { listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    const out = await listSnapshots(dir);
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots: returns [] for an empty snapshot dir", async () => {
  const { listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await fs.mkdir(snapshotDir(dir), { recursive: true });
    const out = await listSnapshots(dir);
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots: orphan .json without .meta.json is excluded", async () => {
  const { createSnapshot, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    await fs.writeFile(path.join(snapshotDir(dir), "orphan-id.json"), "{}");
    const out = await listSnapshots(dir);
    assert.equal(out.length, 1, `expected 1 listed snapshot; got ${out.length}`);
    assert.match(out[0].id, SNAPSHOT_ID_PATTERN);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots: orphan .meta.json without .json is excluded", async () => {
  const { listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await fs.mkdir(snapshotDir(dir), { recursive: true });
    const orphan = { id: "orphan", reason: "force-init", bytes: 2, sha256: "ab", created_at: "2026-01-01T00:00:00.000Z" };
    await fs.writeFile(path.join(snapshotDir(dir), "orphan.meta.json"), JSON.stringify(orphan));
    const out = await listSnapshots(dir);
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots: sorted descending by id (newest first)", async () => {
  const { createSnapshot, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    const m1 = await createSnapshot(dir, "force-init");
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await createSnapshot(dir, "force-init");
    await new Promise((r) => setTimeout(r, 5));
    const m3 = await createSnapshot(dir, "force-init");
    const out = await listSnapshots(dir);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, m3.id);
    assert.equal(out[1].id, m2.id);
    assert.equal(out[2].id, m1.id);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots: excludes snapshots with corrupt metadata (unparseable JSON)", async () => {
  const { createSnapshot, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    const entries = await fs.readdir(snapshotDir(dir));
    const metaFile = entries.find((e) => e.endsWith(".meta.json"));
    await fs.writeFile(path.join(snapshotDir(dir), metaFile), "{ not json");
    const out = await listSnapshots(dir);
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots: excludes snapshots where meta.id does not match filename", async () => {
  const { createSnapshot, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    const entries = await fs.readdir(snapshotDir(dir));
    const metaFile = entries.find((e) => e.endsWith(".meta.json"));
    const metaPath = path.join(snapshotDir(dir), metaFile);
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.id = "tampered-id";
    await fs.writeFile(metaPath, JSON.stringify(meta));
    const out = await listSnapshots(dir);
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots: lists multiple snapshots with mixed reasons", async () => {
  const { createSnapshot, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir);
    const m1 = await createSnapshot(dir, "force-init");
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await createSnapshot(dir, "corrupt-recovery");
    await new Promise((r) => setTimeout(r, 5));
    const m3 = await createSnapshot(dir, "pre-restore");
    const out = await listSnapshots(dir);
    assert.equal(out.length, 3);
    assert.equal(out[0].reason, "pre-restore");
    assert.equal(out[1].reason, "corrupt-recovery");
    assert.equal(out[2].reason, "force-init");
    assert.equal(out[0].id, m3.id);
    assert.equal(out[2].id, m1.id);
  } finally {
    await rmTempProject(dir);
  }
});

// =====================================================================
// init integration: force-init and corrupt-recovery paths
// =====================================================================

test("init --force on existing v3 state: snapshot reason=force-init, raw preserves the pre-reset state", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { readState, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    // Pre-existing v3 state with a sentinel.
    await bootstrapState(dir, (s) => {
      s.nodes["Sentinel-A"] = { id: "Sentinel-A", title: "alive" };
    });
    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const after = await readState(dir);
    assert.equal(after.version, 3);
    assert.deepEqual(after.nodes, {});
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].reason, "force-init");
    const snapRaw = await rawReadback(dir, snaps[0].id);
    assert.ok(snapRaw.toString("utf8").includes("Sentinel-A"),
      `snapshot raw must preserve Sentinel-A; got ${snapRaw.toString("utf8").slice(0, 200)}`);
  } finally {
    await rmTempProject(dir);
  }
});

test("init --force on existing v1 state: snapshot reason=force-init, raw preserves the v1 bytes verbatim", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { readState, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    // Bootstrap v3 metadata first so stateFile() resolves.
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const file = stateFilePath(dir);
    const v1Raw = JSON.stringify({
      version: 1,
      tasks: { T1: { id: "T1", title: "v1" } },
      decisions: {}, gotchas: {}, initiatives: {}, log: [],
    });
    await fs.writeFile(file, v1Raw);
    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const after = await readState(dir);
    assert.equal(after.version, 3);
    assert.deepEqual(after.nodes, {});
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].reason, "force-init");
    const snapRaw = await rawReadback(dir, snaps[0].id);
    assert.ok(snapRaw.toString("utf8").includes("\"version\":1"),
      `snapshot raw must preserve v1 bytes; got ${snapRaw.toString("utf8").slice(0, 200)}`);
  } finally {
    await rmTempProject(dir);
  }
});

test("init recovery on corrupt JSON (no --force): snapshot reason=corrupt-recovery, raw preserves garbage", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { readState, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const file = stateFilePath(dir);
    const corruptRaw = "{ this is not JSON\n";
    await fs.writeFile(file, corruptRaw);
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const after = await readState(dir);
    assert.equal(after.version, 3);
    assert.deepEqual(after.nodes, {});
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].reason, "corrupt-recovery");
    const snapRaw = await rawReadback(dir, snaps[0].id);
    assert.equal(snapRaw.toString("utf8"), corruptRaw);
  } finally {
    await rmTempProject(dir);
  }
});

test("init on missing state (no file): no snapshot is created", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("init on valid existing state without --force: refuses and does NOT create a snapshot", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await bootstrapState(dir, (s) => {
      s.nodes["T1"] = { id: "T1", title: "alive" };
    });
    await assert.rejects(() => init({ statePath: dir, flags: {}, positional: [], projectDir: dir }));
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("init --force twice creates two snapshots, newest first; original pre-reset data is recoverable from the first", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { readState, listSnapshots } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    // First pre-existing state: "alpha".
    await bootstrapState(dir, (s) => {
      s.nodes["Alpha"] = { id: "Alpha", title: "first" };
    });
    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    // After the first force-init, the state is empty. Populate "beta" and force-init again.
    const { writeState } = await importFresh("./storage/state.mjs");
    await writeState(dir, { version: 3, nodes: { Beta: { id: "Beta", title: "second" } }, edges: [], initiatives: {}, log: [] });
    await new Promise((r) => setTimeout(r, 5));
    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const after = await readState(dir);
    assert.deepEqual(after.nodes, {});
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 2);
    assert.equal(snaps[0].reason, "force-init");
    assert.equal(snaps[1].reason, "force-init");
    // Newest first.
    const newestRaw = await rawReadback(dir, snaps[0].id);
    assert.ok(newestRaw.toString("utf8").includes("Beta"),
      `newest snapshot should preserve Beta; got ${newestRaw.toString("utf8").slice(0, 200)}`);
    const oldestRaw = await rawReadback(dir, snaps[1].id);
    assert.ok(oldestRaw.toString("utf8").includes("Alpha"),
      `oldest snapshot should preserve Alpha; got ${oldestRaw.toString("utf8").slice(0, 200)}`);
  } finally {
    await rmTempProject(dir);
  }
});
