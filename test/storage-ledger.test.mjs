import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { stateFile } from "../src/storage/state.mjs";
import { withLock } from "../src/storage/lock.mjs";
import {
  bootstrapFencedState,
  bootstrapFencedStateUnderLock,
  ledgerFile,
  readFencedState,
  readFencedStateUnderLock,
} from "../src/storage/ledger.mjs";

function preFenceState() {
  return {
    version: 4,
    nodes: {
      T1: { id: "T1", revision: 8 },
      T2: { id: "T2", revision: 12 },
    },
    edges: [],
    initiatives: {},
    log: [],
    revision: 10,
  };
}

async function seedState(projectDir, state = preFenceState()) {
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const raw = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(file, raw, "utf8");
  return { file, raw };
}

async function createProjectForTest(t) {
  const projectDir = await createTempProject();
  t.after(() => rmTempProject(projectDir));
  return projectDir;
}

async function readUnderLock(projectDir) {
  return withLock(projectDir, readFencedStateUnderLock);
}

async function bootstrapUnderLock(projectDir, initialState, options) {
  return withLock(projectDir, (context) => bootstrapFencedStateUnderLock(context, initialState, options));
}

async function captureExpiredLockContext(projectDir) {
  let expiredContext;
  await withLock(projectDir, (context) => { expiredContext = context; });
  return expiredContext;
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error.code === "ENOENT") { return false; }
    throw error;
  }
}

const nodeRevision = (node) => node.revision;
const isRacingLegacyWrite = (entry) => entry.action === "racing-legacy-write";

async function rejectForeignReadCapability(projectDir, otherProject) {
  await withLock(otherProject, (foreignContext) => assert.rejects(readFencedStateUnderLock(foreignContext, { projectDir }), { code: "CLIMIER_INVALID_LOCK_CONTEXT" }));
}

async function readExpiredBootstrapCapability(projectDir) {
  const expiredContext = await captureExpiredLockContext(projectDir);
  await assert.rejects(bootstrapFencedStateUnderLock(expiredContext, preFenceState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
}

async function rejectForeignBootstrapCapability(projectDir, otherProject) {
  await withLock(otherProject, (foreignContext) => assert.rejects(bootstrapFencedStateUnderLock(foreignContext, preFenceState(), { projectDir }), { code: "CLIMIER_INVALID_LOCK_CONTEXT" }));
}

test("under-lock fenced read rejects expired and foreign lock capabilities", async (t) => {
  const projectDir = await createProjectForTest(t);
  const otherProject = await createProjectForTest(t);
  const expiredContext = await captureExpiredLockContext(projectDir);
  await assert.rejects(readFencedStateUnderLock(expiredContext), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await rejectForeignReadCapability(projectDir, otherProject);
});

test("under-lock fenced read returns null without creating paths for an absent project", async (t) => {
  const projectDir = await createProjectForTest(t);
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  const result = await readUnderLock(projectDir);

  assert.equal(result, null);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
  await assert.rejects(fs.access(ledgerPath), { code: "ENOENT" });
});

test("under-lock fenced read rejects v5 state without its ledger", async (t) => {
  const projectDir = await createProjectForTest(t);
  const { file } = await seedState(projectDir);
  await bootstrapFencedState(projectDir);
  await fs.unlink(ledgerFile(projectDir));
  await assert.rejects(
    readUnderLock(projectDir),
    { code: "CLIMIER_LEDGER_MISSING" },
  );
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 5);
});

test("under-lock fenced read fails closed for ledger-only projects unless bootstrap is pending", async (t) => {
  const projectDir = await createProjectForTest(t);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify({
    version: 1,
    fence_generation: 1,
    high_water_revision: 1,
    migration_pending: null,
    bootstrap_pending: null,
  }), "utf8");

  await assert.rejects(
    readUnderLock(projectDir),
    { code: "CLIMIER_LEDGER_STATE_MISMATCH" },
  );
  await assert.rejects(fs.access(stateFile(projectDir)), { code: "ENOENT" });
});

test("legacy update racing under-lock migration is fenced after migration publishes", async (t) => {
  const projectDir = await createProjectForTest(t);
  const { file } = await seedState(projectDir);
  const { updateState } = await import("../src/storage/state.mjs");
  let unlockMigration;
  let migrationLocked;
  const lockEntered = new Promise((resolve) => { migrationLocked = resolve; });
  const holdMigration = new Promise((resolve) => { unlockMigration = resolve; });
  const migration = withLock(projectDir, async (lockContext) => {
    const state = await readFencedStateUnderLock(lockContext);
    migrationLocked();
    await holdMigration;
    return state;
  });
  await lockEntered;

  const legacyWrite = updateState(projectDir, (state) => {
    state.log.push({ action: "racing-legacy-write" });
    return state;
  });
  unlockMigration();
  const migrated = await migration;
  await assert.rejects(legacyWrite, { code: "CLIMIER_LEDGER_REQUIRED" });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), migrated);
  assert.equal(migrated.log.some(isRacingLegacyWrite), false);
});

test("under-lock fenced read migrates existing legacy state with exact fingerprints", async (t) => {
  const projectDir = await createProjectForTest(t);
  const { file, raw: sourceRaw } = await seedState(projectDir);
  const state = await readUnderLock(projectDir);
  const destinationRaw = await fs.readFile(file, "utf8");
  const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));

  assert.equal(state.version, 5);
  assert.equal(ledger.migration_pending, null);
  assert.equal(ledger.last_migration.source_sha256, crypto.createHash("sha256").update(sourceRaw).digest("hex"));
  assert.equal(ledger.last_migration.destination_sha256, crypto.createHash("sha256").update(destinationRaw).digest("hex"));
  assert.deepEqual(await readFencedState(projectDir), state);
});

test("ledger bootstrap migrates pre-fence state to v5 and records exact fingerprints", async (t) => {
  const projectDir = await createProjectForTest(t);
  const { raw: sourceRaw } = await seedState(projectDir);
  const state = await bootstrapFencedState(projectDir);
  const destinationRaw = await fs.readFile(stateFile(projectDir), "utf8");
  const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));

  assert.equal(state.version, 5);
  assert.equal(state.fence_generation, 1);
  assert.equal(state.revision, 13);
  assert.deepEqual(Object.values(state.nodes).map(nodeRevision), [13, 13]);
  assert.equal(ledger.high_water_revision, 13);
  assert.equal(ledger.fence_generation, 1);
  assert.equal(ledger.migration_pending, null);
  assert.equal(ledger.last_migration.source_sha256, crypto.createHash("sha256").update(sourceRaw).digest("hex"));
  assert.equal(ledger.last_migration.destination_sha256, crypto.createHash("sha256").update(destinationRaw).digest("hex"));
  assert.equal((await readFencedState(projectDir)).fence_generation, 1);
});

test("fenced bootstrap creates an initial canonical v1 state under an active lock without reacquiring", async (t) => {
  const projectDir = await createProjectForTest(t);
  const initialState = {
    version: 4,
    nodes: { T1: { id: "T1", revision: 3 } },
    edges: [],
    initiatives: {},
    log: [{ action: "authorized-bootstrap" }],
    revision: 2,
  };
  const result = await Promise.race([
    withLock(projectDir, async (lockContext) => {
      const state = await bootstrapFencedStateUnderLock(lockContext, initialState);
      assert.ok(await fileExists(path.join(path.dirname(stateFile(projectDir)), ".lock")));
      return state;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap reacquired the held lock")), 1000)),
  ]);
  assert.equal(result.version, 1);
  assert.equal(result.fence_generation, 1);
  assert.equal(result.revision, 4);
  assert.deepEqual((await readFencedState(projectDir)).log, [{ action: "authorized-bootstrap" }]);
});

test("fenced bootstrap rejects invalid lock capabilities before storage access", async () => {
  await assert.rejects(bootstrapFencedStateUnderLock(null, preFenceState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(bootstrapFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock context must not be inspected"); },
  }), preFenceState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  const projectDir = await createTempProject();
  const otherProject = await createTempProject();
  try {
    await readExpiredBootstrapCapability(projectDir);
    await rejectForeignBootstrapCapability(projectDir, otherProject);
  } finally {
    await rmTempProject(projectDir);
    await rmTempProject(otherProject);
  }
});

test("fenced bootstrap does not overwrite an existing state or ledger", async (testContext) => {
  for (const existing of ["state", "ledger"]) {
    await testContext.test(existing, async (t) => {
      const projectDir = await createProjectForTest(t);
      const statePath = stateFile(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const initialState = preFenceState();
      if (existing === "state") {
        await fs.writeFile(statePath, "sentinel-state", "utf8");
      } else {
        await fs.writeFile(ledgerPath, "sentinel-ledger", "utf8");
      }
      await assert.rejects(bootstrapUnderLock(projectDir, initialState), { code: "CLIMIER_FENCED_BOOTSTRAP_EXISTS" });
      if (existing === "state") {
        assert.equal(await fs.readFile(statePath, "utf8"), "sentinel-state");
      } else {
        assert.equal(await fs.readFile(ledgerPath, "utf8"), "sentinel-ledger");
      }
    });
  }
});

test("fenced bootstrap recovers interrupted initial publication without divergent state or ledger", async (testContext) => {
  for (const faultAt of ["before-pending", "after-pending", "after-state-create"]) {
    await testContext.test(faultAt, async (t) => {
      const projectDir = await createProjectForTest(t);
      const initialState = { ...preFenceState(), log: [{ action: "only-once" }] };
      await assert.rejects(bootstrapUnderLock(projectDir, initialState, { faultAt }), /injected failure/);
      const statePath = stateFile(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      const stateExists = await fileExists(statePath);
      const ledgerExists = await fileExists(ledgerPath);
      assert.equal(stateExists, faultAt === "after-state-create");
      assert.equal(ledgerExists, faultAt !== "before-pending");
      const state = await bootstrapUnderLock(projectDir, initialState);
      assert.equal(state.version, 1);
      assert.deepEqual(state.log, [{ action: "only-once" }]);
      assert.deepEqual(await readFencedState(projectDir), state);
      const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      assert.equal(ledger.high_water_revision, state.revision);
      assert.equal(ledger.bootstrap_pending, null);
      if (faultAt === "after-pending") {
        const recovered = await readFencedState(projectDir);
        assert.deepEqual(recovered, state);
      }
    });
  }
});

test("fenced bootstrap rejects a retry with a different initial-state fingerprint", async (t) => {
  const projectDir = await createProjectForTest(t);
  const initialState = { ...preFenceState(), log: [{ action: "original" }] };
  await assert.rejects(withLock(projectDir, (context) =>
    bootstrapFencedStateUnderLock(context, initialState, { faultAt: "after-pending" })), /injected failure/);
  const altered = { ...initialState, log: [{ action: "different" }] };
  await assert.rejects(withLock(projectDir, (context) =>
    bootstrapFencedStateUnderLock(context, altered)), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
  assert.equal(await fileExists(stateFile(projectDir)), false);
  assert.ok(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).bootstrap_pending);
  const recovered = await withLock(projectDir, (context) =>
    bootstrapFencedStateUnderLock(context, initialState));
  assert.deepEqual(recovered.log, [{ action: "original" }]);
});

test("ledger bootstrap recovers a failure before pending is durable without changing source", async (t) => {
  const projectDir = await createProjectForTest(t);
  const { file, raw } = await seedState(projectDir);
  await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "before-pending" }), /injected failure/);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  assert.equal(await fileExists(ledgerFile(projectDir)), false);
  assert.equal((await bootstrapFencedState(projectDir)).version, 5);
});

test("ledger bootstrap resumes from durable pending when state rename has not happened", async (t) => {
  const projectDir = await createProjectForTest(t);
  const { file, raw: sourceRaw } = await seedState(projectDir);
  await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-pending" }), /injected failure/);
  const pendingLedger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
  const pending = pendingLedger.migration_pending;
  assert.equal(pending.source_sha256, crypto.createHash("sha256").update(sourceRaw).digest("hex"));
  assert.match(pending.destination_sha256, /^[a-f0-9]{64}$/);
  assert.equal(pending.source_high_water_revision, 12);
  assert.equal(pending.fence_revision, pendingLedger.high_water_revision);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 4);
  assert.equal((await bootstrapFencedState(projectDir)).version, 5);
  const destinationRaw = await fs.readFile(file, "utf8");
  assert.equal(pending.destination_sha256, crypto.createHash("sha256").update(destinationRaw).digest("hex"));
  assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).migration_pending, null);
});

test("under-lock read recovers only the exact durable migration pending record", async (testContext) => {
  for (const faultAt of ["after-pending", "after-state-rename"]) {
    await testContext.test(faultAt, async (t) => {
      const projectDir = await createProjectForTest(t);
      const { raw: sourceRaw } = await seedState(projectDir);
      await assert.rejects(bootstrapFencedState(projectDir, { faultAt }), /injected failure/);
      const beforeRecoveryLedger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
      const pending = beforeRecoveryLedger.migration_pending;
      assert.equal(pending.source_sha256, crypto.createHash("sha256").update(sourceRaw).digest("hex"));

      const recovered = await readUnderLock(projectDir);
      const stateRaw = await fs.readFile(stateFile(projectDir), "utf8");
      const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
      assert.equal(recovered.version, 5);
      assert.equal(pending.destination_sha256, crypto.createHash("sha256").update(stateRaw).digest("hex"));
      assert.equal(ledger.migration_pending, null);
      assert.equal(ledger.last_migration.source_sha256, pending.source_sha256);
      assert.equal(ledger.last_migration.destination_sha256, pending.destination_sha256);
      assert.deepEqual(await readFencedState(projectDir), recovered);
    });
  }
});

test("ledger bootstrap resumes after state rename and clears pending durably", async (t) => {
  const projectDir = await createProjectForTest(t);
  await seedState(projectDir);
  await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-state-rename" }), /injected failure/);
  assert.equal(JSON.parse(await fs.readFile(stateFile(projectDir), "utf8")).version, 5);
  assert.notEqual(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).migration_pending, null);
  const state = await bootstrapFencedState(projectDir);
  assert.equal(state.version, 5);
  assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).migration_pending, null);
});

test("ledger bootstrap rejects a source that does not match the pending fingerprint", async (t) => {
  const projectDir = await createProjectForTest(t);
  const { file } = await seedState(projectDir);
  await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-pending" }), /injected failure/);
  const changed = preFenceState();
  changed.nodes.T1.revision++;
  await fs.writeFile(file, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
  await assert.rejects(bootstrapFencedState(projectDir), /fingerprint|regression/i);
});

test("ledger bootstrap fails closed for corrupt or missing ledger after fencing", async (t) => {
  const projectDir = await createProjectForTest(t);
  await seedState(projectDir);
  await bootstrapFencedState(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.writeFile(ledgerPath, "{broken", "utf8");
  await assert.rejects(bootstrapFencedState(projectDir), /ledger.*corrupt|invalid ledger/i);
  await fs.unlink(ledgerPath);
  await assert.rejects(bootstrapFencedState(projectDir), /ledger.*missing|missing ledger/i);
  await assert.rejects(readFencedState(projectDir), /ledger.*missing|missing ledger/i);
});
