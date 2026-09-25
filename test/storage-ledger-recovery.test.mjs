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
  ledgerFile,
  recoverFencedStateUnderLock,
} from "../src/storage/ledger.mjs";

function legacyState(revision = 10) {
  return {
    version: 4,
    nodes: { T1: { id: "T1", revision: 8 }, T2: { id: "T2", revision: 12 } },
    edges: [],
    initiatives: {},
    log: [{ action: "legacy" }],
    revision,
  };
}

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

async function seedLegacy(projectDir) {
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(legacyState(), null, 2)}\n`, "utf8");
  return file;
}

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function recover(projectDir, candidate, options) {
  return withLock(projectDir, (lockContext) => recoverFencedStateUnderLock(lockContext, candidate, options));
}

test("fenced recovery rejects invalid lock capabilities before storage access", async () => {
  await assert.rejects(recoverFencedStateUnderLock(null), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(recoverFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock capability must not be inspected"); },
  })), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
});

test("fenced recovery rebases stale legacy state above local high-water and preserves generation", async () => {
  await withProject(async (projectDir) => {
    const statePath = await seedLegacy(projectDir);
    const fenced = await bootstrapFencedState(projectDir);
    const ledgerPath = ledgerFile(projectDir);
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    ledger.fence_generation = 7;
    ledger.high_water_revision = 40;
    await fs.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    const stale = legacyState(5);
    stale.nodes.T1.revision = 2;
    stale.nodes.T2.revision = 4;
    await fs.writeFile(statePath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
    const candidate = legacyState(3);
    candidate.nodes.T1.title = "recovered payload";
    candidate.log = [{ action: "restore-payload" }];

    const recovered = await recover(projectDir, candidate);
    const after = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.equal(recovered.version, 5);
    assert.equal(recovered.fence_generation, 7);
    assert.ok(recovered.revision > 40);
    assert.ok(Object.values(recovered.nodes).every((node) => node.revision > 40));
    assert.equal(after.fence_generation, 7);
    assert.equal(after.high_water_revision, recovered.revision);
    assert.equal(after.recovery_pending, null);
    assert.equal(recovered.nodes.T1.title, "recovered payload");
    assert.deepEqual(recovered.log, [{ action: "restore-payload" }]);
    assert.deepEqual(await recover(projectDir, candidate), recovered);
    assert.notEqual(fenced.revision, recovered.revision);
  });
});

test("fenced recovery refuses to reconstruct an absent or invalid local ledger", async (t) => {
  for (const mode of ["absent", "corrupt"]) {
    await t.test(mode, async () => withProject(async (projectDir) => {
      const statePath = await seedLegacy(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      if (mode === "corrupt") await fs.writeFile(ledgerPath, "{broken", "utf8");
      await assert.rejects(recover(projectDir), mode === "absent"
        ? { code: "CLIMIER_LEDGER_MISSING" }
        : { code: "CLIMIER_CORRUPT_LEDGER" });
      assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).version, 4);
    }));
  }
});

test("fenced recovery resumes only exact pending source or destination after crashes", async (t) => {
  for (const faultAt of ["before-stage", "after-stage", "before-pending", "after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"]) {
    await t.test(faultAt, async () => withProject(async (projectDir) => {
      const statePath = await seedLegacy(projectDir);
      await bootstrapFencedState(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      const sourceState = legacyState();
      const sourceRaw = `${JSON.stringify(sourceState, null, 2)}\n`;
      await fs.writeFile(statePath, sourceRaw, "utf8");
      const before = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      await assert.rejects(recover(projectDir, sourceState, { faultAt }), /injected failure/);

      const currentLedger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      const pending = currentLedger.recovery_pending;
      const pendingDurable = ["after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"].includes(faultAt);
      assert.equal(Boolean(pending), pendingDurable);
      if (!pendingDurable) {
        assert.equal(currentLedger.high_water_revision, before.high_water_revision);
        assert.equal(await fs.readFile(statePath, "utf8"), sourceRaw);
      } else {
        assert.equal(pending.source_sha256, sha256(sourceRaw));
        assert.match(pending.destination_sha256, /^[a-f0-9]{64}$/);
      }

      const recovered = await recover(projectDir, sourceState);
      const rawDestination = await fs.readFile(statePath, "utf8");
      const after = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      assert.equal(recovered.version, 5);
      assert.equal(after.recovery_pending, null);
      if (pending) assert.equal(pending.destination_sha256, sha256(rawDestination));
      assert.deepEqual(await recover(projectDir), recovered);
      assert.deepEqual(await withLock(projectDir, (lockContext) =>
        recoverFencedStateUnderLock(lockContext, sourceState)), recovered);
    }));
  }
});

test("fenced recovery fails closed for divergent state and adulterated stage", async (t) => {
  for (const alteration of ["state", "stage", "ledger"]) {
    await t.test(alteration, async () => withProject(async (projectDir) => {
      const statePath = await seedLegacy(projectDir);
      await bootstrapFencedState(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      await fs.writeFile(statePath, `${JSON.stringify(legacyState(), null, 2)}\n`, "utf8");
      await assert.rejects(recover(projectDir, JSON.parse(await fs.readFile(statePath, "utf8")), { faultAt: "after-pending" }), /injected failure/);
      const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      const pending = ledger.recovery_pending;
      if (alteration === "state") {
        await fs.writeFile(statePath, `${JSON.stringify({ ...legacyState(), log: [{ action: "diverged" }] }, null, 2)}\n`, "utf8");
      } else if (alteration === "stage") {
        await fs.writeFile(path.join(path.dirname(statePath), `.recovery-stage-${pending.stage_id}`), "tampered", "utf8");
      } else {
        ledger.high_water_revision += 1;
        await fs.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      }

      await assert.rejects(recover(projectDir), alteration === "ledger"
        ? { code: "CLIMIER_INVALID_LEDGER" }
        : { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
      assert.ok(JSON.parse(await fs.readFile(ledgerPath, "utf8")).recovery_pending);
    }));
  }
});
