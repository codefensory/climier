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

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

test("ledger bootstrap migrates pre-fence state to v5 and records exact fingerprints", async () => {
  await withProject(async (projectDir) => {
    const { raw: sourceRaw } = await seedState(projectDir);
    const state = await bootstrapFencedState(projectDir);
    const destinationRaw = await fs.readFile(stateFile(projectDir), "utf8");
    const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));

    assert.equal(state.version, 5);
    assert.equal(state.fence_generation, 1);
    assert.equal(state.revision, 13);
    assert.deepEqual(Object.values(state.nodes).map((node) => node.revision), [13, 13]);
    assert.equal(ledger.high_water_revision, 13);
    assert.equal(ledger.fence_generation, 1);
    assert.equal(ledger.migration_pending, null);
    assert.equal(ledger.last_migration.source_sha256, crypto.createHash("sha256").update(sourceRaw).digest("hex"));
    assert.equal(ledger.last_migration.destination_sha256, crypto.createHash("sha256").update(destinationRaw).digest("hex"));
    assert.equal((await readFencedState(projectDir)).fence_generation, 1);
  });
});

test("fenced bootstrap creates an initial v5 state under an active lock without reacquiring", async () => {
  await withProject(async (projectDir) => {
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
        assert.equal(await fs.stat(path.join(path.dirname(stateFile(projectDir)), ".lock")).then(() => true), true);
        return state;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap reacquired the held lock")), 1000)),
    ]);
    assert.equal(result.version, 5);
    assert.equal(result.fence_generation, 1);
    assert.equal(result.revision, 4);
    assert.deepEqual((await readFencedState(projectDir)).log, [{ action: "authorized-bootstrap" }]);
  });
});

test("fenced bootstrap rejects invalid lock capabilities before storage access", async () => {
  await assert.rejects(bootstrapFencedStateUnderLock(null, preFenceState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(bootstrapFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock context must not be inspected"); },
  }), preFenceState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await withProject(async (projectDir) => {
    const otherProject = await createTempProject();
    try {
      let expiredContext;
      await withLock(projectDir, (context) => { expiredContext = context; });
      await assert.rejects(bootstrapFencedStateUnderLock(expiredContext, preFenceState()), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
      await withLock(otherProject, async (foreignContext) => {
        await assert.rejects(bootstrapFencedStateUnderLock(foreignContext, preFenceState(), { projectDir }), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
      });
    } finally {
      await rmTempProject(otherProject);
    }
  });
});

test("fenced bootstrap does not overwrite an existing state or ledger", async (t) => {
  for (const existing of ["state", "ledger"]) {
    await t.test(existing, async () => withProject(async (projectDir) => {
      const statePath = stateFile(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const initialState = preFenceState();
      if (existing === "state") await fs.writeFile(statePath, "sentinel-state", "utf8");
      else await fs.writeFile(ledgerPath, "sentinel-ledger", "utf8");
      await assert.rejects(withLock(projectDir, (context) =>
        bootstrapFencedStateUnderLock(context, initialState)), { code: "CLIMIER_FENCED_BOOTSTRAP_EXISTS" });
      if (existing === "state") assert.equal(await fs.readFile(statePath, "utf8"), "sentinel-state");
      else assert.equal(await fs.readFile(ledgerPath, "utf8"), "sentinel-ledger");
    }));
  }
});

test("fenced bootstrap recovers interrupted initial publication without divergent state or ledger", async (t) => {
  for (const faultAt of ["before-pending", "after-pending", "after-state-create"]) {
    await t.test(faultAt, async () => withProject(async (projectDir) => {
      const initialState = { ...preFenceState(), log: [{ action: "only-once" }] };
      await assert.rejects(withLock(projectDir, (context) =>
        bootstrapFencedStateUnderLock(context, initialState, { faultAt })), /injected failure/);
      const statePath = stateFile(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      const stateExists = await fs.stat(statePath).then(() => true, () => false);
      const ledgerExists = await fs.stat(ledgerPath).then(() => true, () => false);
      assert.equal(stateExists, faultAt === "after-state-create");
      assert.equal(ledgerExists, faultAt !== "before-pending");
      const state = await withLock(projectDir, (context) =>
        bootstrapFencedStateUnderLock(context, initialState));
      assert.equal(state.version, 5);
      assert.deepEqual(state.log, [{ action: "only-once" }]);
      assert.deepEqual(await readFencedState(projectDir), state);
      const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      assert.equal(ledger.high_water_revision, state.revision);
      assert.equal(ledger.bootstrap_pending, null);
      if (faultAt === "after-pending") {
        const recovered = await readFencedState(projectDir);
        assert.deepEqual(recovered, state);
      }
    }));
  }
});

test("fenced bootstrap rejects a retry with a different initial-state fingerprint", async () => {
  await withProject(async (projectDir) => {
    const initialState = { ...preFenceState(), log: [{ action: "original" }] };
    await assert.rejects(withLock(projectDir, (context) =>
      bootstrapFencedStateUnderLock(context, initialState, { faultAt: "after-pending" })), /injected failure/);
    const altered = { ...initialState, log: [{ action: "different" }] };
    await assert.rejects(withLock(projectDir, (context) =>
      bootstrapFencedStateUnderLock(context, altered)), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
    assert.equal(await fs.stat(stateFile(projectDir)).then(() => true, () => false), false);
    assert.ok(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).bootstrap_pending);
    const recovered = await withLock(projectDir, (context) =>
      bootstrapFencedStateUnderLock(context, initialState));
    assert.deepEqual(recovered.log, [{ action: "original" }]);
  });
});

test("ledger bootstrap recovers a failure before pending is durable without changing source", async () => {
  await withProject(async (projectDir) => {
    const { file, raw } = await seedState(projectDir);
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "before-pending" }), /injected failure/);
    assert.equal(await fs.readFile(file, "utf8"), raw);
    assert.equal(await fs.stat(ledgerFile(projectDir)).then(() => true, () => false), false);
    assert.equal((await bootstrapFencedState(projectDir)).version, 5);
  });
});

test("ledger bootstrap resumes from durable pending when state rename has not happened", async () => {
  await withProject(async (projectDir) => {
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
});

test("ledger bootstrap resumes after state rename and clears pending durably", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-state-rename" }), /injected failure/);
    assert.equal(JSON.parse(await fs.readFile(stateFile(projectDir), "utf8")).version, 5);
    assert.notEqual(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).migration_pending, null);
    const state = await bootstrapFencedState(projectDir);
    assert.equal(state.version, 5);
    assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).migration_pending, null);
  });
});

test("ledger bootstrap rejects a source that does not match the pending fingerprint", async () => {
  await withProject(async (projectDir) => {
    const { file } = await seedState(projectDir);
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-pending" }), /injected failure/);
    const changed = preFenceState();
    changed.nodes.T1.revision++;
    await fs.writeFile(file, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
    await assert.rejects(bootstrapFencedState(projectDir), /fingerprint|regression/i);
  });
});

test("ledger bootstrap fails closed for corrupt or missing ledger after fencing", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    await bootstrapFencedState(projectDir);
    const ledgerPath = ledgerFile(projectDir);
    await fs.writeFile(ledgerPath, "{broken", "utf8");
    await assert.rejects(bootstrapFencedState(projectDir), /ledger.*corrupt|invalid ledger/i);
    await fs.unlink(ledgerPath);
    await assert.rejects(bootstrapFencedState(projectDir), /ledger.*missing|missing ledger/i);
    await assert.rejects(readFencedState(projectDir), /ledger.*missing|missing ledger/i);
  });
});
