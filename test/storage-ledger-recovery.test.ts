import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { stateFile } from "../src/storage/state.ts";
import { withLock } from "../src/storage/lock.ts";
import {
  bootstrapFencedState,
  commitFencedStateUnderLock,
  ledgerFile,
  readFencedState,
  recoverFencedStateUnderLock,
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

function canonicalState(revision = 10, fenceGeneration = 1): TestState {
  return {
    version: 1,
    fence_generation: fenceGeneration,
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

async function runProjectSubtest(t, label, fn) {
  await t.test(label, () => withProject(fn));
}

function allNodesAboveRevision(state: TestState, revision: number) {
  return Object.values(state.nodes).every((node) => node.revision > revision);
}

async function expectCommitAfterPending(projectDir, candidate) {
  await assert.rejects(
    withLock(projectDir, (lockContext) => commitFencedStateUnderLock(lockContext, candidate, { faultAt: "after-pending" })),
    /injected failure/,
  );
}

async function readRecoveryUnderLock(projectDir, state) {
  return withLock(projectDir, (lockContext) => recoverFencedStateUnderLock(lockContext, state));
}

async function prepareStaleRecovery(projectDir) {
  const fenced = asTestState(await bootstrapFencedState(projectDir));
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  ledger.fence_generation = 7;
  ledger.high_water_revision = 40;
  await fs.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const stale = canonicalState(5, 6);
  stale.log = [{ action: "stale-canonical-source" }];
  stale.nodes.T1.revision = 2;
  stale.nodes.T2.revision = 4;
  await fs.writeFile(statePath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  const candidate = { ...canonicalState(3), fence_generation: 7 };
  candidate.nodes.T1.title = "recovered payload";
  candidate.log = [{ action: "restore-payload" }];
  return { fenced, candidate, ledgerPath };
}

async function prepareRecoveryCrash(projectDir) {
  const statePath = stateFile(projectDir);
  await bootstrapFencedState(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  const sourceState = { ...canonicalState(), fence_generation: 1 };
  const sourceRaw = `${JSON.stringify(sourceState, null, 2)}\n`;
  await fs.writeFile(statePath, sourceRaw, "utf8");
  const before = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  return { statePath, ledgerPath, sourceState, sourceRaw, before };
}

async function verifyRecoveryCrashState(faultAt, setup) {
  const currentLedger = JSON.parse(await fs.readFile(setup.ledgerPath, "utf8"));
  const pending = currentLedger.recovery_pending;
  const pendingDurable = ["after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"].includes(faultAt);
  assert.equal(Boolean(pending), pendingDurable);
  if (pendingDurable) {
    assert.equal(pending.source_sha256, sha256(setup.sourceRaw));
    assert.match(pending.destination_sha256, /^[a-f0-9]{64}$/);
  } else {
    assert.equal(currentLedger.high_water_revision, setup.before.high_water_revision);
    assert.equal(await fs.readFile(setup.statePath, "utf8"), setup.sourceRaw);
  }
  return pending;
}

async function verifyRecoveryCrashRetry(projectDir, setup, pending) {
  const recovered = asTestState(await recover(projectDir, setup.sourceState));
  const rawDestination = await fs.readFile(setup.statePath, "utf8");
  const after = JSON.parse(await fs.readFile(setup.ledgerPath, "utf8"));
  assert.equal(recovered.version, 1);
  assert.equal(after.recovery_pending, null);
  if (pending) {assert.equal(pending.destination_sha256, sha256(rawDestination));}
  assert.deepEqual(await recover(projectDir), recovered);
  assert.deepEqual(await readRecoveryUnderLock(projectDir, setup.sourceState), recovered);
}

async function runRecoveryAlteration(projectDir, alteration) {
  await bootstrapFencedState(projectDir);
  const statePath = stateFile(projectDir);
  const ledgerPath = ledgerFile(projectDir);
  const canonicalSource = { ...canonicalState(), fence_generation: 1 };
  await fs.writeFile(statePath, `${JSON.stringify(canonicalSource, null, 2)}\n`, "utf8");
  await assert.rejects(recover(projectDir, canonicalSource, { faultAt: "after-pending" }), /injected failure/);
  const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  const pending = ledger.recovery_pending;
  if (alteration === "state") {
    await fs.writeFile(statePath, `${JSON.stringify({ ...canonicalSource, log: [{ action: "diverged" }] }, null, 2)}\n`, "utf8");
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
}

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function recover(projectDir, candidate: unknown = undefined, options: Record<string, unknown> = {}) {
  return withLock(projectDir, (lockContext) => recoverFencedStateUnderLock(lockContext, candidate, options));
}

test("fenced recovery rejects invalid lock capabilities before storage access", async () => {
  await assert.rejects(recoverFencedStateUnderLock(null as unknown as object, undefined), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(recoverFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock capability must not be inspected"); },
  }), undefined), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
});

test("fenced recovery rebases stale legacy state above local high-water and preserves generation", async () => {
  await withProject(async (projectDir) => {
    const { fenced, candidate, ledgerPath } = await prepareStaleRecovery(projectDir);
    const recovered = asTestState(await recover(projectDir, candidate));
    const after = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.equal(recovered.version, 1);
    assert.equal(recovered.fence_generation, 7);
    assert.ok(recovered.revision > 40);
    assert.ok(allNodesAboveRevision(recovered, 40));
    assert.equal(after.fence_generation, 7);
    assert.equal(after.high_water_revision, recovered.revision);
    assert.equal(after.recovery_pending, null);
    assert.equal(recovered.nodes.T1.title, "recovered payload");
    assert.deepEqual(recovered.log, [{ action: "restore-payload" }]);
    assert.deepEqual(await recover(projectDir, candidate), recovered);
    assert.notEqual(fenced.revision, recovered.revision);
  });
});

test("recovery checkpoint is invalidated durably before a normal fenced commit", async () => {
  await withProject(async (projectDir) => {
    const { candidate, ledgerPath } = await prepareStaleRecovery(projectDir);
    const recovered = asTestState(await recover(projectDir, candidate));
    assert.ok(JSON.parse(await fs.readFile(ledgerPath, "utf8")).last_recovery);
    const commitCandidate = {
      ...recovered,
      revision: recovered.revision + 1,
      log: [...recovered.log, { action: "commit-after-recovery" }],
    };

    await expectCommitAfterPending(projectDir, commitCandidate);
    const pending = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.equal(pending.last_recovery, undefined);
    assert.ok(pending.commit_pending);
    assert.deepEqual(await readFencedState(projectDir), commitCandidate);
    assert.deepEqual(await readFencedState(projectDir), commitCandidate);
  });
});

test("recovery without a candidate retries durable null input fingerprints", async () => {
  await withProject(async (projectDir) => {
    const setup = await prepareRecoveryCrash(projectDir);
    await assert.rejects(recover(projectDir, undefined, { faultAt: "after-pending" }), /injected failure/);

    const durableLedger = JSON.parse(await fs.readFile(setup.ledgerPath, "utf8"));
    assert.equal(durableLedger.recovery_pending.input_sha256, null);
    await fs.writeFile(setup.ledgerPath, `${JSON.stringify(durableLedger, null, 2)}\n`, "utf8");

    const recovered = asTestState(await readFencedState(projectDir));
    assert.equal(recovered.version, 1);
    assert.equal(JSON.parse(await fs.readFile(setup.ledgerPath, "utf8")).recovery_pending, null);
    assert.deepEqual(await readFencedState(projectDir), recovered);
  });
});

test("recovery pending with an explicit candidate still requires its matching fingerprint", async () => {
  await withProject(async (projectDir) => {
    const setup = await prepareRecoveryCrash(projectDir);
    const candidate = { ...setup.sourceState, log: [{ action: "explicit-candidate" }] };
    await assert.rejects(recover(projectDir, candidate, { faultAt: "after-pending" }), /injected failure/);
    const ledger = JSON.parse(await fs.readFile(setup.ledgerPath, "utf8"));
    ledger.recovery_pending.input_sha256 = null;
    await fs.writeFile(setup.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

    await assert.rejects(recover(projectDir, setup.sourceState), { code: "CLIMIER_INVALID_LEDGER" });
  });
});

test("fenced recovery refuses to reconstruct an absent or invalid local ledger", async (t) => {
  for (const mode of ["absent", "corrupt"]) {
    await runProjectSubtest(t, mode, async (projectDir) => {
      await bootstrapFencedState(projectDir);
      const statePath = stateFile(projectDir);
      const ledgerPath = ledgerFile(projectDir);
      if (mode === "corrupt") {await fs.writeFile(ledgerPath, "{broken", "utf8");}
      else { await fs.unlink(ledgerPath); }
      await assert.rejects(recover(projectDir), mode === "absent"
        ? { code: "CLIMIER_LEDGER_MISSING" }
        : { code: "CLIMIER_CORRUPT_LEDGER" });
      assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).version, 1);
    });
  }
});

test("fenced recovery resumes only exact pending source or destination after crashes", async (t) => {
  for (const faultAt of ["before-stage", "after-stage", "before-pending", "after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"]) {
      await runProjectSubtest(t, faultAt, async (projectDir) => {
        const setup = await prepareRecoveryCrash(projectDir);
        await assert.rejects(recover(projectDir, setup.sourceState, { faultAt }), /injected failure/);

        const pending = await verifyRecoveryCrashState(faultAt, setup);
        await verifyRecoveryCrashRetry(projectDir, setup, pending);
      });
  }
});

test("fenced recovery fails closed for divergent state and adulterated stage", async (t) => {
  for (const alteration of ["state", "stage", "ledger"]) {
    await runProjectSubtest(t, alteration, (projectDir) => runRecoveryAlteration(projectDir, alteration));
  }
});
