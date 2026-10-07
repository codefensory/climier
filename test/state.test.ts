/* oxlint-disable max-lines -- migration and persistence regression inventory is intentionally kept together. */
// state.mjs: read/write/atomic-write the tasks.json state file.
import { test } from "node:test";
import assert from "node:assert/strict";
import pathModule from "node:path";
import { createTempProject, rmTempProject, importFresh, stateFilePath } from "./helpers.ts";

type StateError = { code?: string; message: string; details?: { version?: number; file?: string; hint?: string } };
type FenceCase = [string, Record<string, number>, RegExp];

test("readState returns null if file missing", async () => {
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    const s = await readState(dir);
    assert.equal(s, null);
  } finally {
    await rmTempProject(dir);
  }
});

test("readState fails closed for ledger-only projects and recovers exact pending bootstrap", async (t) => {
  const { readState } = await importFresh("./storage/state.ts");
  const { bootstrapFencedState, ledgerFile } = await importFresh("./storage/ledger.ts");
  const { stateFile } = await importFresh("./storage/state.ts");
  const fs = await import("node:fs/promises");

  await t.test("ledger without state or pending bootstrap", async () => {
    const dir = await createTempProject();
    try {
      const ledgerPath = ledgerFile(dir);
      await fs.mkdir(pathModule.dirname(ledgerPath), { recursive: true });
      await fs.writeFile(ledgerPath, JSON.stringify({
        version: 1, fence_generation: 1, high_water_revision: 1,
      }), "utf8");
      await assert.rejects(readState(dir), { code: "CLIMIER_LEDGER_STATE_MISMATCH" });
      await assert.rejects(fs.access(stateFile(dir)), { code: "ENOENT" });
    } finally {
      await rmTempProject(dir);
    }
  });

  await t.test("exact bootstrap pending", async () => {
    const dir = await createTempProject();
    try {
      const initial = { version: 1, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 };
      await assert.rejects(bootstrapFencedState(dir, { faultAt: "after-pending" }), /injected failure/);
      const recovered = await readState(dir);
      assert.equal(recovered.version, 1);
      assert.equal(recovered.fence_generation, 1);
      assert.deepEqual(recovered.log, initial.log);
      assert.notEqual(await fs.readFile(stateFile(dir), "utf8"), "");
    } finally {
      await rmTempProject(dir);
    }
  });
});

test("emptyState returns a valid empty canonical schema", async () => {
  const { emptyState } = await importFresh("./storage/state.ts");
  const s = emptyState();
  assert.equal(s.version, 1);
  assert.equal(s.fence_generation, 1);
  assert.equal(s.revision, 0);
  assert.deepEqual(s.nodes, {});
  assert.deepEqual(s.edges, []);
  assert.deepEqual(s.initiatives, {});
  assert.deepEqual(s.log, []);
  // No pre-release collections.
  assert.equal(s.tasks, undefined);
  assert.equal(s.decisions, undefined);
  assert.equal(s.gotchas, undefined);
});

test("readState classifies pre-release v1 structure before checking its version", async () => {
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {

    // project someone is trying to migrate from.
    const fs = await import("node:fs/promises");
    const file = stateFilePath(dir);
    await fs.mkdir(pathModule.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      tasks: { T1: { id: "T1", title: "x" } },
      decisions: {}, gotchas: {}, initiatives: {}, log: [],
    }), "utf8");
    let caught;
    try { await readState(dir); } catch (e) { caught = e; }
    assert.ok(caught, "readState should throw on a v1 file");
    const stateError = caught as StateError;
    assert.equal(stateError.code, "PRE_RELEASE_STATE_UNSUPPORTED");
    assert.ok(stateError.details, "must expose structured details");
    assert.equal(stateError.details!.version, 1);
    assert.equal(stateError.details!.file, file);
    assert.match(stateError.details!.hint || "", /climier migrate/i);
    assert.match(stateError.message, /pre-release/i);
    assert.match(stateError.message, /climier migrate/i);
    assert.doesNotMatch(stateError.message, /init --force/i);
  } finally { await rmTempProject(dir); }
});

test("unknown future schema version is rejected on read and write", async () => {
  const { readState, writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    const fs = await import("node:fs/promises");
    const file = stateFilePath(dir);
    await fs.mkdir(pathModule.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 6, nodes: {}, edges: [], initiatives: {}, log: [] }), "utf8");
    let caught;
    try { await readState(dir); } catch (e) { caught = e; }
    assert.equal((caught as StateError).code, "CLIMIER_INCOMPATIBLE_VERSION");
    await assert.rejects(writeState(dir, { version: 6, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 }),
      { code: "CLIMIER_INCOMPATIBLE_VERSION" });
  } finally { await rmTempProject(dir); }
});

test("readState accepts canonical v1 state when its revision ledger is present", async () => {
  const { readState, stateFile } = await importFresh("./storage/state.ts");
  const { bootstrapFencedState } = await importFresh("./storage/ledger.ts");
  const fs = await import("node:fs/promises");
  const dir = await createTempProject();
  try {
    const fenced = await bootstrapFencedState(dir);
    const canonical = { ...fenced, version: 1 };
    await fs.writeFile(stateFile(dir), JSON.stringify(canonical), "utf8");

    const read = await readState(dir) as { version: number; fence_generation?: number; nodes: unknown };
    assert.equal(read.version, 1);
    assert.ok(Number.isInteger(read.fence_generation));
    assert.deepEqual(read.nodes, canonical.nodes);
  } finally { await rmTempProject(dir); }
});

test("readState rejects canonical v1 state without fence or ledger", async (t) => {
  const { readState } = await importFresh("./storage/state.ts");
  const fs = await import("node:fs/promises");
  const cases: FenceCase[] = [
    ["no fence", {}, /fence_generation/i],
    ["no ledger", { fence_generation: 1 }, /revision-ledger/],
  ];
  for (const [name, extra, reason] of cases) {
    await t.test(name, async () => {
      const dir = await createTempProject();
      try {
        const file = stateFilePath(dir);
        await fs.mkdir(pathModule.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ version: 1, nodes: {}, edges: [], initiatives: {}, log: [], ...extra }), "utf8");
        await assert.rejects(readState(dir), (error) => {
          const stateError = error as StateError;
          return stateError.code === "CLIMIER_NONCANONICAL_STATE" && reason.test(stateError.message);
        });
      } finally { await rmTempProject(dir); }
    });
  }
});

test("readState rejects incomplete canonical v1 state", async () => {
  const { readState } = await importFresh("./storage/state.ts");
  const fs = await import("node:fs/promises");
  const dir = await createTempProject();
  try {
    const file = stateFilePath(dir);
    await fs.mkdir(pathModule.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, nodes: {}, edges: [], initiatives: {} }), "utf8");
    await assert.rejects(readState(dir), { code: "CLIMIER_INCOMPLETE_STATE" });
  } finally { await rmTempProject(dir); }
});

test("writeState rejects a v1-shaped object with a clear error", async () => {
  const { writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    const v1 = { version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
    let caught;
    try { await writeState(dir, v1); } catch (e) { caught = e; }
    assert.ok(caught, "writeState must reject the pre-canonical shape");
    assert.match((caught as StateError).message, /pre-canonical|run climier migrate/i);
  } finally { await rmTempProject(dir); }
});

test("writeState rejects a v2 object missing the v2 collections", async () => {
  const { writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    const bad = { version: 2, nodes: {}, edges: [] };
    let caught;
    try { await writeState(dir, bad); } catch (e) { caught = e; }
    assert.ok(caught, "writeState must reject missing collections");
    assert.match((caught as StateError).message, /missing (initiatives|log) collection/);
  } finally { await rmTempProject(dir); }
});

const appendLegacyEntry = (state) => ({ ...state, log: [...state.log, { action: "legacy" }] });

test("direct state writers reject ledger-backed and fenced projects before mutation", async (t) => {
  const { writeState, updateState } = await importFresh("./storage/state.ts");
  const { ledgerFile, bootstrapFencedState } = await importFresh("./storage/ledger.ts");
  const fs = await import("node:fs/promises");
  for (const fencedBy of ["v5-state", "ledger"]) {
    await t.test(fencedBy, async () => {
      const dir = await createTempProject();
      try {
        const file = stateFilePath(dir);
        await fs.mkdir(pathModule.dirname(file), { recursive: true });
        if (fencedBy === "v5-state") {
          await bootstrapFencedState(dir);
        } else {
          await fs.writeFile(file, JSON.stringify({ version: 4, nodes: {}, edges: [], initiatives: {}, log: [], revision: 0 }), "utf8");
          await fs.writeFile(ledgerFile(dir), "{}", "utf8");
        }
        const before = await fs.readFile(file, "utf8");
        await assert.rejects(writeState(dir, { version: 4, nodes: {}, edges: [], initiatives: {}, log: [] }), { code: "CLIMIER_LEDGER_REQUIRED" });
        await assert.rejects(updateState(dir, appendLegacyEntry), { code: "CLIMIER_LEDGER_REQUIRED" });
        assert.equal(await fs.readFile(file, "utf8"), before);
      } finally {
        await rmTempProject(dir);
      }
    });
  }
});

test("canonical-only reader rejects versions 2 through 5 while retaining classification", async (t) => {
  const { readState, classifyStateShape, stateFile } = await importFresh("./storage/state.ts");
  const { bootstrapFencedState } = await importFresh("./storage/ledger.ts");
  const fs = await import("node:fs/promises");
  for (const version of [2, 3, 4, 5]) {
    await t.test(`version ${version}`, async () => {
      const dir = await createTempProject();
      try {
        await bootstrapFencedState(dir);
        const shape = { version, nodes: {}, edges: [], initiatives: {}, log: [], ...(version === 5 ? { fence_generation: 1 } : {}) };
        await fs.writeFile(stateFile(dir), JSON.stringify(shape), "utf8");
        await assert.rejects(readState(dir), (error) => {
          const stateError = error as StateError;
          return stateError.code === "CLIMIER_INCOMPATIBLE_VERSION" && /climier migrate/i.test(stateError.message);
        });
        assert.equal(classifyStateShape(shape).kind, version === 5 ? "fenced-legacy" : "legacy");
      } finally { await rmTempProject(dir); }
    });
  }
});

test("canonical-only ledger protocols load without the migration module", async () => {
  await Promise.all([
    importFresh("./storage/ledger/recovery.ts"),
    importFresh("./storage/ledger/bootstrap.ts"),
    importFresh("./storage/ledger/replace.ts"),
    importFresh("./storage/ledger.ts"),
  ]);
});
