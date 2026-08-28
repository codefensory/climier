// snapshots-restore.test.mjs — `snapshots` listing and `restore` command.
//
// Cubre ADR-004 §§Commands/Plan 3 y ADR-008 §"`restore` e `init --force`":
// el comando read-only `snapshots` y el comando mutante
// `restore <snapshot-id> --as <agent>` que valida target v2/shape, toma
// un snapshot pre-restore del estado actual, restaura bajo lock y
// agrega un log `{ action: "restore", agent, snapshot_id }` al estado
// restaurado. Depende de los primitives `createSnapshot` /
// `listSnapshots` introducidos en Plan 1.
//
// T-plugin-policy-migration-tests / ADR-008: el bypass histórico
// orchestrator/recovery se reemplaza por una policy opcional (ver
// test/plugin-policy-seam-state-ops.test.mjs). Este archivo conserva
// happy-path y error-path con `as: "test-agent"` (nominal).
//
// Casos cubiertos:
//   - snapshots: shape, sort, completitud, exclusion de pares incompletos
//   - restore happy path: --as <any-non-empty agent>, raw preservado,
//     pre-restore snapshot reason=pre-restore, log entry en el estado restaurado
//   - restore authority: --as faltante, --as con valor no permitido
//   - restore error paths: target ausente / incompleto / corrupto / v1 / futuro / shape inválido
//   - restore invariante: cualquier fallo deja el estado intacto
//   - CLI dispatch via bin

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
} from "./helpers.mjs";

const SNAPSHOT_ID_PATTERN = /^(\d{8}T\d{9}Z)-(force-init|corrupt-recovery|pre-restore)-([0-9a-f]{8})$/;

function snapshotDir(dir) {
  return path.join(path.dirname(stateFilePath(dir)), "snapshots");
}

function rawBytes(dir, id) {
  return fs.readFile(path.join(snapshotDir(dir), `${id}.json`));
}

async function bootstrapState(dir, mutate) {
  const base = { version: 2, nodes: {}, edges: [], initiatives: {}, log: [] };
  if (typeof mutate === "function") mutate(base);
  await writeState(dir, base);
  return base;
}

// =========================================================================
// `snapshots` command (read-only)
// =========================================================================

test("snapshots command: returns { snapshots: [...] }", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.ok(Array.isArray(out.snapshots));
    assert.equal(out.snapshots.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: returns [] when no snapshot dir exists", async () => {
  const dir = await createTempProject();
  try {
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.deepEqual(out, { snapshots: [] });
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: returns [] for an empty snapshot dir", async () => {
  const dir = await createTempProject();
  try {
    await fs.mkdir(snapshotDir(dir), { recursive: true });
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.deepEqual(out, { snapshots: [] });
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: sorted descending by id (newest first)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    await bootstrapState(dir);
    const m1 = await createSnapshot(dir, "force-init");
    await new Promise((r) => setTimeout(r, 5));
    const m2 = await createSnapshot(dir, "force-init");
    await new Promise((r) => setTimeout(r, 5));
    const m3 = await createSnapshot(dir, "force-init");
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.equal(out.snapshots.length, 3);
    assert.equal(out.snapshots[0].id, m3.id);
    assert.equal(out.snapshots[1].id, m2.id);
    assert.equal(out.snapshots[2].id, m1.id);
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: each entry has id, created_at, reason, bytes (and sha256 for completeness)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.equal(out.snapshots.length, 1);
    const m = out.snapshots[0];
    assert.equal(typeof m.id, "string");
    assert.match(m.id, SNAPSHOT_ID_PATTERN);
    assert.equal(typeof m.created_at, "string");
    assert.ok(!Number.isNaN(Date.parse(m.created_at)));
    assert.equal(m.reason, "force-init");
    assert.equal(typeof m.bytes, "number");
    assert.ok(m.bytes > 0);
    assert.equal(typeof m.sha256, "string");
    assert.equal(m.sha256.length, 64);
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: excludes orphan raw (no metadata)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    await fs.writeFile(path.join(snapshotDir(dir), "orphan-raw.json"), "{}");
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.equal(out.snapshots.length, 1);
    assert.match(out.snapshots[0].id, SNAPSHOT_ID_PATTERN);
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: excludes orphan metadata (no raw)", async () => {
  const dir = await createTempProject();
  try {
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    await fs.mkdir(snapshotDir(dir), { recursive: true });
    await fs.writeFile(
      path.join(snapshotDir(dir), "orphan.meta.json"),
      JSON.stringify({ id: "orphan", reason: "force-init", bytes: 2, sha256: "ab", created_at: "2026-01-01T00:00:00.000Z" }),
    );
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.deepEqual(out, { snapshots: [] });
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: excludes snapshots with corrupt metadata", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    await bootstrapState(dir);
    await createSnapshot(dir, "force-init");
    const entries = await fs.readdir(snapshotDir(dir));
    const metaFile = entries.find((e) => e.endsWith(".meta.json"));
    await fs.writeFile(path.join(snapshotDir(dir), metaFile), "{ not json");
    const out = await snapshots({ statePath: dir, flags: {}, positional: [] });
    assert.deepEqual(out, { snapshots: [] });
  } finally {
    await rmTempProject(dir);
  }
});

test("snapshots command: accepts no flags (idempotent knownFlags = [])", async () => {
  const dir = await createTempProject();
  try {
    const { default: snapshots } = await importFresh("./commands/snapshots.mjs");
    await assert.doesNotReject(() => snapshots({ statePath: dir, flags: {}, positional: [] }));
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// `restore` happy path
// =========================================================================

test("restore: --as <any-non-empty> succeeds and returns { snapshot } with full metadata (ADR-008)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const baseline = await bootstrapState(dir, (s) => {
      s.nodes["Sentinel"] = { id: "Sentinel", title: "alive" };
    });
    const meta = await createSnapshot(dir, "force-init");
    // Replace the state with an empty one (simulating init --force).
    await bootstrapState(dir);
    const out = await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    assert.ok(out.snapshot);
    assert.equal(out.snapshot.id, meta.id);
    assert.equal(out.snapshot.reason, "force-init");
    // State was restored to the baseline raw bytes.
    const restored = await readState(dir);
    assert.deepEqual(restored.nodes, baseline.nodes);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: --as <any-non-empty> succeeds with second-actor identity (ADR-008)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const baseline = await bootstrapState(dir, (s) => {
      s.nodes["Sentinel"] = { id: "Sentinel", title: "alive" };
    });
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    const out = await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    assert.ok(out.snapshot);
    assert.equal(out.snapshot.id, meta.id);
    const restored = await readState(dir);
    assert.deepEqual(restored.nodes, baseline.nodes);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: replaces state with snapshot raw bytes verbatim (content matches baseline, plus the appended restore log entry)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const baseline = await bootstrapState(dir, (s) => {
      s.nodes["X"] = { id: "X", title: "restored" };
      s.initiatives["bench"] = { desc: "bench", created_at: "2026-01-01T00:00:00.000Z" };
      s.log.push({ ts: "2026-01-01T00:00:00.000Z", agent: "test", action: "seed", note: "preset" });
      s.edges.push({ from: "X", to: "Y", type: "BLOCKS" });
    });
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    const restored = await readState(dir);
    // The restored state should equal baseline plus the appended restore log entry.
    assert.deepEqual(restored.nodes, baseline.nodes);
    assert.deepEqual(restored.initiatives, baseline.initiatives);
    assert.deepEqual(restored.edges, baseline.edges);
    // The log carries the baseline entries plus one restore entry appended after.
    const restoreEntries = restored.log.filter((e) => e.action === "restore");
    assert.equal(restoreEntries.length, 1);
    assert.deepEqual(restored.log.slice(0, baseline.log.length), baseline.log);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: takes a pre-restore snapshot of the current state (reason=pre-restore)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot, listSnapshots } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const baseline = await bootstrapState(dir, (s) => {
      s.nodes["Sentinel"] = { id: "Sentinel", title: "alive" };
    });
    const meta = await createSnapshot(dir, "force-init");
    // After force-init, the state is empty. That empty state is what
    // we expect to be preserved as pre-restore.
    await bootstrapState(dir);
    await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    const snaps = await listSnapshots(dir);
    const preRestore = snaps.find((s) => s.reason === "pre-restore");
    assert.ok(preRestore, `expected a pre-restore snapshot; got reasons: ${snaps.map((s) => s.reason).join(",")}`);
    // The pre-restore snapshot raw must preserve the empty state we replaced.
    const preRaw = await rawBytes(dir, preRestore.id);
    assert.equal(preRaw.toString("utf8").includes("Sentinel"), false,
      "pre-restore raw should NOT contain Sentinel (it was the empty state)");
    // Restored state contains the baseline.
    const restored = await readState(dir);
    assert.deepEqual(restored.nodes, baseline.nodes);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: appends log entry { action: 'restore', agent, snapshot_id } to the RESTORED state", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    const after = await readState(dir);
    const restoreEntries = after.log.filter((e) => e.action === "restore");
    assert.equal(restoreEntries.length, 1, `expected 1 restore entry; got ${after.log.length} entries`);
    assert.equal(restoreEntries[0].agent, "test-agent");
    assert.equal(restoreEntries[0].snapshot_id, meta.id);
    assert.equal(typeof restoreEntries[0].ts, "string");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: log entry uses --as agent (recovery agent is recorded)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    const after = await readState(dir);
    const restoreEntries = after.log.filter((e) => e.action === "restore");
    assert.equal(restoreEntries.length, 1);
    assert.equal(restoreEntries[0].agent, "test-agent");
    assert.equal(restoreEntries[0].snapshot_id, meta.id);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: pre-restore snapshot happens BEFORE the state file is replaced (atomic ordering)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot, listSnapshots } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    const snaps = await listSnapshots(dir);
    // The pre-restore snapshot's created_at must be earlier than the
    // restore log entry's ts (the restore happened later). We assert
    // monotonicity via the snapshot id (timestamp-prefixed).
    const preRestore = snaps.find((s) => s.reason === "pre-restore");
    assert.ok(preRestore);
    const after = await readState(dir);
    const restoreEntries = after.log.filter((e) => e.action === "restore");
    assert.equal(restoreEntries.length, 1);
    assert.ok(Date.parse(preRestore.created_at) <= Date.parse(restoreEntries[0].ts),
      `pre-restore.created_at (${preRestore.created_at}) must be <= restore.ts (${restoreEntries[0].ts})`);
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// `restore` authority: ADR-008 — any non-empty --as succeeds when no policy is installed (seam abstains → defaults core).
// =========================================================================

test("restore: --as missing fails with structured error", async () => {
  const dir = await createTempProject();
  const prevAgent = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    let captured;
    try {
      await restore({ statePath: dir, flags: {}, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "MISSING_AGENT");
  } finally {
    if (prevAgent === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prevAgent;
    await rmTempProject(dir);
  }
});

test("restore: a plain agent (e.g. alice) restores when no policy is installed (ADR-008: no role hatch)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    // ADR-008 §"restore e init --force" removed the
    // orchestrator/recovery comparison: with no policy installed the
    // seam abstains and the default core lets any actor restore.
    // Policy allow/deny/abstain/throw coverage (including "deny leaves
    // no orphan pre-restore snapshot") lives in
    // test/plugin-policy-seam-state-ops.test.mjs.
    const out = await restore({ statePath: dir, flags: { as: "alice" }, positional: [meta.id] });
    assert.equal(out.snapshot.id, meta.id);
    // The successful restore DID create the pre-restore snapshot.
    const { listSnapshots } = await importFresh("./state.mjs");
    const snaps = await listSnapshots(dir);
    assert.ok(snaps.find((s) => s.reason === "pre-restore"));
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: --as with empty string fails with MISSING_AGENT (resolveAgent trims and surfaces as missing)", async () => {
  const dir = await createTempProject();
  const prevAgent = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "MISSING_AGENT");
  } finally {
    if (prevAgent === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prevAgent;
    await rmTempProject(dir);
  }
});

test("restore: missing id (no positional) fails with MISSING_FIELD", async () => {
  const dir = await createTempProject();
  try {
    const { default: restore } = await importFresh("./commands/restore.mjs");
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "MISSING_FIELD");
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// `restore` error paths: target validation must fail without modifying state
// =========================================================================

test("restore: target missing (no raw file) fails with NODE_NOT_FOUND and leaves state intact", async () => {
  const dir = await createTempProject();
  try {
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const before = await readState(dir);
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: ["does-not-exist"] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "NODE_NOT_FOUND");
    // State bytes unchanged.
    const after = await readState(dir);
    assert.deepEqual(after, before);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: target has raw but no metadata (incomplete pair) fails and leaves state intact", async () => {
  const dir = await createTempProject();
  try {
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const before = await readState(dir);
    // Drop an orphan raw file (no metadata pair).
    const orphanId = "20260101T000000000Z-force-init-deadbeef";
    await fs.mkdir(snapshotDir(dir), { recursive: true });
    await fs.writeFile(path.join(snapshotDir(dir), `${orphanId}.json`), JSON.stringify({ version: 2, nodes: {}, edges: [], initiatives: {}, log: [] }));
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [orphanId] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "NODE_NOT_FOUND");
    const after = await readState(dir);
    assert.deepEqual(after, before);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: target has metadata but no raw (incomplete pair) fails", async () => {
  const dir = await createTempProject();
  try {
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const orphanId = "20260101T000000000Z-force-init-deadbeef";
    await fs.mkdir(snapshotDir(dir), { recursive: true });
    await fs.writeFile(
      path.join(snapshotDir(dir), `${orphanId}.meta.json`),
      JSON.stringify({ id: orphanId, created_at: "2026-01-01T00:00:00.000Z", reason: "force-init", bytes: 2, sha256: "ab" }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [orphanId] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "NODE_NOT_FOUND");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: metadata id mismatches filename fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    // Tamper with metadata.id so it differs from the filename.
    const metaPath = path.join(snapshotDir(dir), `${meta.id}.meta.json`);
    const parsed = JSON.parse(await fs.readFile(metaPath, "utf8"));
    parsed.id = "tampered-id";
    await fs.writeFile(metaPath, JSON.stringify(parsed));
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "NODE_NOT_FOUND");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: corrupt metadata (unparseable JSON) fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.writeFile(path.join(snapshotDir(dir), `${meta.id}.meta.json`), "{ not json");
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "NODE_NOT_FOUND");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw is corrupt (not JSON) fails and leaves state intact", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir, (s) => {
      s.nodes["Sentinel"] = { id: "Sentinel", title: "alive" };
    });
    const meta = await createSnapshot(dir, "corrupt-recovery");
    // Overwrite the raw file with garbage.
    await fs.writeFile(path.join(snapshotDir(dir), `${meta.id}.json`), "{ this is not JSON\n");
    const before = await readState(dir);
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
    const after = await readState(dir);
    assert.deepEqual(after, before);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw is v1 fails (v1 is no longer supported)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    // Replace raw with a v1-shaped JSON.
    await fs.writeFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      JSON.stringify({ version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw is a future version (v3) fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.writeFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      JSON.stringify({ version: 3, nodes: {}, edges: [], initiatives: {}, log: [] }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw missing version field fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.writeFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      JSON.stringify({ nodes: {}, edges: [], initiatives: {}, log: [] }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw is missing a required collection (e.g. no 'nodes') fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    // Drop 'nodes' from the raw file but keep version=2.
    await fs.writeFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      JSON.stringify({ version: 2, edges: [], initiatives: {}, log: [] }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw is missing 'edges' fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.writeFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      JSON.stringify({ version: 2, nodes: {}, initiatives: {}, log: [] }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw is missing 'initiatives' fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.writeFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      JSON.stringify({ version: 2, nodes: {}, edges: [], log: [] }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: raw is missing 'log' fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.writeFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      JSON.stringify({ version: 2, nodes: {}, edges: [], initiatives: {} }),
    );
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: target raw is not a JSON object (e.g. JSON array) fails", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.writeFile(path.join(snapshotDir(dir), `${meta.id}.json`), "[]");
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: current state file missing fails (no pre-restore snapshot possible)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    await bootstrapState(dir);
    const meta = await createSnapshot(dir, "force-init");
    await fs.unlink(stateFilePath(dir));
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    assert.equal(captured.code, "INVALID_STATUS");
    // State file is still missing.
    let exists = true;
    try { await fs.access(stateFilePath(dir)); } catch { exists = false; }
    assert.equal(exists, false);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: on every validation failure, no pre-restore snapshot is created and no state mutation occurs", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot, listSnapshots } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const baseline = await bootstrapState(dir, (s) => {
      s.nodes["Sentinel"] = { id: "Sentinel", title: "alive" };
    });
    const meta = await createSnapshot(dir, "force-init");
    // Snapshot count before the failure: 1 (the force-init we just took).
    const snapsBefore = await listSnapshots(dir);
    assert.equal(snapsBefore.length, 1);
    // Corrupt the raw so validation fails.
    await fs.writeFile(path.join(snapshotDir(dir), `${meta.id}.json`), "not json at all");
    let captured;
    try {
      await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    } catch (e) {
      captured = e;
    }
    assert.ok(captured, "expected restore to throw");
    const after = await readState(dir);
    assert.deepEqual(after, baseline);
    const snapsAfter = await listSnapshots(dir);
    assert.equal(snapsAfter.length, 1, `no pre-restore snapshot must be created on validation failure; got ${snapsAfter.length}`);
    assert.equal(snapsAfter[0].reason, "force-init");
  } finally {
    await rmTempProject(dir);
  }
});

test("restore: same agent restores twice from same snapshot — each call creates its own pre-restore; the live log carries the latest restore entry (older entries live in the pre-restore snapshots)", async () => {
  const dir = await createTempProject();
  try {
    const { createSnapshot, listSnapshots } = await importFresh("./state.mjs");
    const { default: restore } = await importFresh("./commands/restore.mjs");
    const baseline = await bootstrapState(dir, (s) => {
      s.nodes["Sentinel"] = { id: "Sentinel", title: "alive" };
    });
    const meta = await createSnapshot(dir, "force-init");
    await bootstrapState(dir);
    await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    await restore({ statePath: dir, flags: { as: "test-agent" }, positional: [meta.id] });
    const after = await readState(dir);
    assert.deepEqual(after.nodes, baseline.nodes);
    // The live state file is the second restore, whose log equals the
    // snapshot's log (empty baseline.log) plus one appended restore entry.
    const restoreEntries = after.log.filter((e) => e.action === "restore");
    assert.equal(restoreEntries.length, 1);
    assert.equal(restoreEntries[0].agent, "test-agent");
    assert.equal(restoreEntries[0].snapshot_id, meta.id);
    // But the pre-restore snapshots preserve every state that was
    // displaced: the first restore displaced the empty state, the
    // second displaced the first restored state.
    const snaps = await listSnapshots(dir);
    const preRestores = snaps.filter((s) => s.reason === "pre-restore");
    assert.equal(preRestores.length, 2, `expected 2 pre-restore snapshots; got ${preRestores.length}`);
    // The first pre-restore is the empty state (bytes match); the second
    // pre-restore is the first restored state (which has the first
    // restore log entry).
    const sorted = [...preRestores].sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.ok(sorted[0].bytes < sorted[1].bytes,
      `first pre-restore (empty state, ${sorted[0].bytes} bytes) should be smaller than second (${sorted[1].bytes} bytes)`);
  } finally {
    await rmTempProject(dir);
  }
});

// =========================================================================
// CLI dispatch via bin
// =========================================================================

test("CLI: snapshots via bin returns { snapshots: [...] }", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    // Create a force-init snapshot via init --force over a populated state.
    await writeState(dir, {
      version: 2, nodes: { "T1": { id: "T1", title: "alive" } }, edges: [], initiatives: {}, log: [],
    });
    r = await runCli(["--project", dir, "init", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "snapshots"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data.snapshots));
    assert.equal(data.snapshots.length, 1);
    assert.equal(data.snapshots[0].reason, "force-init");
    assert.match(data.snapshots[0].id, SNAPSHOT_ID_PATTERN);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: restore --as <any-non-empty> via bin returns { snapshot } and replaces state (ADR-008)", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    // Pre-existing state with sentinel.
    await writeState(dir, {
      version: 2, nodes: { "Sentinel": { id: "Sentinel", title: "alive" } }, edges: [], initiatives: {}, log: [],
    });
    r = await runCli(["--project", dir, "init", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    // List snapshots and grab the force-init id.
    const list = await runCli(["--project", dir, "snapshots"]);
    assert.equal(list.code, 0, list.stderr);
    const { snapshots } = JSON.parse(list.stdout);
    assert.equal(snapshots.length, 1);
    const targetId = snapshots[0].id;
    // Restore it.
    r = await runCli(["--project", dir, "restore", targetId, "--as", "test-agent"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(data.snapshot);
    assert.equal(data.snapshot.id, targetId);
    // State now contains Sentinel.
    r = await runCli(["--project", dir, "show", "Sentinel"]);
    assert.equal(r.code, 0, r.stderr);
    const shown = JSON.parse(r.stdout);
    assert.equal(shown.node.title, "alive");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: restore accepts any non-empty --as via bin (ADR-008 removed the role check)", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    await writeState(dir, {
      version: 2, nodes: { "Sentinel": { id: "Sentinel", title: "alive" } }, edges: [], initiatives: {}, log: [],
    });
    r = await runCli(["--project", dir, "init", "--force", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const list = await runCli(["--project", dir, "snapshots"]);
    const { snapshots } = JSON.parse(list.stdout);
    const targetId = snapshots[0].id;
    r = await runCli(["--project", dir, "restore", targetId, "--as", "alice"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.snapshot.id, targetId);
    const shown = JSON.parse((await runCli(["--project", dir, "show", "Sentinel"])).stdout);
    assert.equal(shown.node.title, "alive");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: restore rejects missing --as via bin with structured error", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    await writeState(dir, {
      version: 2, nodes: { "Sentinel": { id: "Sentinel", title: "alive" } }, edges: [], initiatives: {}, log: [],
    });
    r = await runCli(["--project", dir, "init", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    const list = await runCli(["--project", dir, "snapshots"]);
    const { snapshots } = JSON.parse(list.stdout);
    const targetId = snapshots[0].id;
    r = await runCli(["--project", dir, "restore", targetId], { env: { CLIMIER_AGENT: "" } });
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "MISSING_AGENT");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --help mentions snapshots and restore", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "--help"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /snapshots/);
    assert.match(r.stdout, /restore/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: snapshots rejects unknown flags via bin", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "snapshots", "--bogus"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error.message || data.error, /unknown flag/);
  } finally {
    await rmTempProject(dir);
  }
});