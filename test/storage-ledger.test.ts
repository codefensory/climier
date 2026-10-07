import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.ts";
import { stateFile } from "../src/storage/state.ts";
import { withLock } from "../src/storage/lock.ts";
import {
  bootstrapFencedState,
  bootstrapFencedStateUnderLock,
  ledgerFile,
  readFencedState,
  readFencedStateUnderLock,
} from "../src/storage/ledger.ts";

type TestNode = { id: string; revision: number; [key: string]: unknown };
type TestState = {
  version: number;
  fence_generation: number;
  revision: number;
  nodes: Record<string, TestNode>;
  edges: unknown[];
  initiatives: Record<string, unknown>;
  log: Array<{ action: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

function asTestState(value: unknown): TestState {
  return value as TestState;
}

async function createProjectForTest(t) {
  const projectDir = await createTempProject();
  t.after(() => rmTempProject(projectDir));
  return projectDir;
}

async function readUnderLock(projectDir, options = {}) {
  return withLock(projectDir, (context) => readFencedStateUnderLock(context, options));
}

async function bootstrapUnderLock(projectDir, initialState, options = {}) {
  return withLock(projectDir, (context) => bootstrapFencedStateUnderLock(context, initialState, options));
}

async function captureExpiredLockContext(projectDir) {
  let expiredContext;
  await withLock(projectDir, (context) => { expiredContext = context; });
  return expiredContext;
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (error: unknown) {
    if (error instanceof Error && error.code === "ENOENT") { return false; }
    throw error;
  }
}

async function rejectForeignReadCapability(projectDir, otherProject) {
  await withLock(otherProject, (foreignContext) => assert.rejects(readFencedStateUnderLock(foreignContext, { projectDir }), { code: "CLIMIER_INVALID_LOCK_CONTEXT" }));
}

const canonicalInitialState = () => ({
  version: 1,
  nodes: { T1: { id: "T1", revision: 3 } },
  edges: [],
  initiatives: {},
  log: [],
  revision: 2,
});

async function readExpiredBootstrapCapability(projectDir) {
  const expiredContext = await captureExpiredLockContext(projectDir);
  await assert.rejects(bootstrapFencedStateUnderLock(expiredContext, canonicalInitialState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
}

async function rejectForeignBootstrapCapability(projectDir, otherProject) {
  await withLock(otherProject, (foreignContext) => assert.rejects(bootstrapFencedStateUnderLock(foreignContext, canonicalInitialState(), { projectDir }), { code: "CLIMIER_INVALID_LOCK_CONTEXT" }));
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

test("under-lock fenced read rejects legacy forms even when a ledger exists", async (t) => {
  for (const version of [2, 3, 4, 5]) {
    await t.test(`version ${version}`, async () => {
      const projectDir = await createProjectForTest(t);
      await bootstrapFencedState(projectDir);
      const state = { version, nodes: {}, edges: [], initiatives: {}, log: [], ...(version === 5 ? { fence_generation: 1 } : {}) };
      await fs.writeFile(stateFile(projectDir), JSON.stringify(state), "utf8");
      await assert.rejects(readUnderLock(projectDir), { code: "CLIMIER_INCOMPATIBLE_VERSION" });
    });
  }
});

test("under-lock fenced read fails closed for ledger-only projects unless bootstrap is pending", async (t) => {
  const projectDir = await createProjectForTest(t);
  const ledgerPath = ledgerFile(projectDir);
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify({
    version: 1,
    fence_generation: 1,
    high_water_revision: 1,
    migration_pending: { legacy: true },
    bootstrap_pending: null,
  }), "utf8");

  await assert.rejects(
    readUnderLock(projectDir),
    { code: "CLIMIER_LEDGER_STATE_MISMATCH" },
  );
  assert.equal(JSON.parse(await fs.readFile(ledgerPath, "utf8")).migration_pending.legacy, true);
  await assert.rejects(fs.access(stateFile(projectDir)), { code: "ENOENT" });
});

test("fenced bootstrap creates an initial canonical v1 state under an active lock without reacquiring", async (t) => {
  const projectDir = await createProjectForTest(t);
  const initialState = { ...canonicalInitialState(), log: [{ action: "authorized-bootstrap" }] };
  const result = asTestState(await Promise.race([
    withLock(projectDir, async (lockContext) => {
      const state = await bootstrapFencedStateUnderLock(lockContext, initialState);
      assert.ok(await fileExists(path.join(path.dirname(stateFile(projectDir)), ".lock")));
      return state;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap reacquired the held lock")), 1000)),
  ]));
  assert.equal(result.version, 1);
  assert.equal(result.fence_generation, 1);
  assert.equal(result.revision, 4);
  assert.deepEqual(asTestState(await readFencedState(projectDir)).log, [{ action: "authorized-bootstrap" }]);
});

test("fenced bootstrap rejects invalid lock capabilities before storage access", async () => {
  await assert.rejects(bootstrapFencedStateUnderLock(null as unknown as object, canonicalInitialState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(bootstrapFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock context must not be inspected"); },
  }), canonicalInitialState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
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
      const initialState = canonicalInitialState();
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
      const initialState = { ...canonicalInitialState(), log: [{ action: "only-once" }] };
      await assert.rejects(bootstrapUnderLock(projectDir, initialState, { faultAt }), /injected failure/);
      const statePath = stateFile(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      const stateExists = await fileExists(statePath);
      const ledgerExists = await fileExists(ledgerPath);
      assert.equal(stateExists, faultAt === "after-state-create");
      assert.equal(ledgerExists, faultAt !== "before-pending");
      const state = asTestState(await bootstrapUnderLock(projectDir, initialState));
      assert.equal(state.version, 1);
      assert.deepEqual(state.log, [{ action: "only-once" }]);
      assert.deepEqual(await readFencedState(projectDir), state);
      const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      assert.equal(ledger.high_water_revision, state.revision);
      assert.equal(ledger.bootstrap_pending, null);
      if (faultAt === "after-pending") {
        const recovered = asTestState(await readFencedState(projectDir));
        assert.deepEqual(recovered, state);
      }
    });
  }
});

test("fenced bootstrap rejects a retry with a different initial-state fingerprint", async (t) => {
  const projectDir = await createProjectForTest(t);
  const initialState = { ...canonicalInitialState(), log: [{ action: "original" }] };
  await assert.rejects(withLock(projectDir, (context) =>
    bootstrapFencedStateUnderLock(context, initialState, { faultAt: "after-pending" })), /injected failure/);
  const altered = { ...initialState, log: [{ action: "different" }] };
  await assert.rejects(withLock(projectDir, (context) =>
    bootstrapFencedStateUnderLock(context, altered)), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
  assert.equal(await fileExists(stateFile(projectDir)), false);
  assert.ok(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).bootstrap_pending);
  const recovered = asTestState(await withLock(projectDir, (context) =>
    bootstrapFencedStateUnderLock(context, initialState)));
  assert.deepEqual(recovered.log, [{ action: "original" }]);
});

test("ledger bootstrap fails closed for corrupt or missing ledger after fencing", async (t) => {
  const projectDir = await createProjectForTest(t);
  await bootstrapFencedState(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  await fs.writeFile(ledgerPath, "{broken", "utf8");
  await assert.rejects(bootstrapFencedState(projectDir), /ledger.*corrupt|invalid ledger/i);
  await fs.unlink(ledgerPath);
  await assert.rejects(bootstrapFencedState(projectDir), { code: "CLIMIER_INCOMPATIBLE_VERSION" });
  await assert.rejects(readFencedState(projectDir), { code: "CLIMIER_LEDGER_MISSING" });
});
