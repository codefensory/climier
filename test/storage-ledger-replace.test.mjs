import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { STATE_SCHEMA_VERSION, stateFile } from "../src/storage/state.mjs";
import { withLock } from "../src/storage/lock.mjs";
import {
  bootstrapFencedState,
  ledgerFile,
  readFencedState,
  recoverFencedStateUnderLock,
  replaceFencedStateUnderLock,
} from "../src/storage/ledger.mjs";

function canonicalState(revision = 10, fenceGeneration = 1) {
  return {
    version: STATE_SCHEMA_VERSION,
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

async function seedFenced(projectDir) {
  await bootstrapFencedState(projectDir);
  const file = stateFile(projectDir);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  const ledgerPath = ledgerFile(projectDir);
  const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  state.fence_generation = 7;
  state.revision = 40;
  state.nodes = Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, { ...node, revision: 40 }]));
  ledger.fence_generation = 7;
  ledger.high_water_revision = 40;
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  return { file, ledgerPath };
}

async function replace(projectDir, candidate, options) {
  return withLock(projectDir, (lockContext) => replaceFencedStateUnderLock(lockContext, candidate, options));
}

async function runProjectSubtest(t, label, fn) {
  await t.test(label, () => withProject(fn));
}

async function recoverCanonicalState(projectDir, statePath) {
  const stale = canonicalState(5, 7);
  stale.nodes.T1.revision = 2;
  stale.nodes.T2.revision = 4;
  stale.log = [{ action: "stale-canonical-source" }];
  await fs.writeFile(statePath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
  return withLock(projectDir, (lockContext) => recoverFencedStateUnderLock(lockContext));
}

function replacementCandidate() {
  const candidate = canonicalState(3);
  candidate.nodes.T1.revision = 2;
  candidate.nodes.T2.revision = 4;
  candidate.nodes.T1.title = "restored payload";
  candidate.log = [{ action: "restore-payload" }];
  return candidate;
}

function assertRebasedReplacement(replaced, ledger) {
  assert.equal(replaced.version, STATE_SCHEMA_VERSION);
  assert.equal(replaced.fence_generation, 7);
  assert.equal(replaced.revision, 41);
  assert.ok(Object.values(replaced.nodes).every((node) => node.revision === 41));
  assert.equal(replaced.nodes.T1.title, "restored payload");
  assert.deepEqual(replaced.log, [{ action: "restore-payload" }]);
  assert.equal(ledger.fence_generation, 7);
  assert.equal(ledger.high_water_revision, 41);
  assert.equal(ledger.replace_pending, null);
}

async function assertPendingReplace(projectDir, setup, faultAt) {
  const { file, candidate, sourceRaw, pendingLedger } = setup;
  const pending = pendingLedger.replace_pending;
  const pendingDurable = ["after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"].includes(faultAt);
  assert.equal(Boolean(pending), pendingDurable);
  if (!pendingDurable) {
    assert.equal(pendingLedger.high_water_revision, 40);
    assert.equal(await fs.readFile(file, "utf8"), sourceRaw);
    return replace(projectDir, candidate);
  }
  assert.equal(pending.source_sha256, sha(sourceRaw));
  assert.match(pending.destination_sha256, /^[a-f0-9]{64}$/);
  const wrongRetry = { ...candidate, log: [{ action: "different-payload" }] };
  await assert.rejects(replace(projectDir, wrongRetry), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
  return readFencedState(projectDir);
}

async function runReplaceCrash(projectDir, faultAt) {
  const { file, ledgerPath } = await seedFenced(projectDir);
  const sourceRaw = await fs.readFile(file, "utf8");
  const candidate = canonicalState(3);
  candidate.log = [{ action: "crash-replace" }];
  await assert.rejects(replace(projectDir, candidate, { faultAt }), /injected failure/);
  const pendingLedger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  const replaced = await assertPendingReplace(projectDir, { file, candidate, sourceRaw, pendingLedger }, faultAt);
  assert.equal(replaced.version, STATE_SCHEMA_VERSION);
  assert.equal(replaced.fence_generation, 7);
  assert.equal(replaced.revision, 41);
  assert.equal(JSON.parse(await fs.readFile(ledgerPath, "utf8")).replace_pending, null);
  assert.deepEqual(await replace(projectDir, candidate), replaced);
}

async function runReplaceAlteration(projectDir, alteration) {
  const { file, ledgerPath } = await seedFenced(projectDir);
  const candidate = canonicalState(3);
  await assert.rejects(replace(projectDir, candidate, { faultAt: "after-pending" }), /injected failure/);
  const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  const pending = ledger.replace_pending;
  if (alteration === "state") {
    const changed = JSON.parse(await fs.readFile(file, "utf8"));
    changed.log = [{ action: "tampered" }];
    await fs.writeFile(file, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
  } else if (alteration === "stage") {
    await fs.writeFile(path.join(path.dirname(file), `.replace-stage-${pending.stage_id}`), "tampered", "utf8");
  } else {
    ledger.high_water_revision += 1;
    await fs.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  }
  await assert.rejects(replace(projectDir, candidate), alteration === "ledger"
    ? { code: "CLIMIER_INVALID_LEDGER" }
    : { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
  assert.ok(JSON.parse(await fs.readFile(ledgerPath, "utf8")).replace_pending);
}

async function runMissingOrCorruptLedger(projectDir, mode) {
  const { file, ledgerPath } = await seedFenced(projectDir);
  if (mode === "absent") {await fs.unlink(ledgerPath);}
  else if (mode === "corrupt") {await fs.writeFile(ledgerPath, "{broken", "utf8");}
  else {
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.fence_generation += 1;
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  const errorCodes = {
    absent: "CLIMIER_LEDGER_MISSING",
    corrupt: "CLIMIER_CORRUPT_LEDGER",
    state: "CLIMIER_LEDGER_STATE_MISMATCH",
  };
  const expected = errorCodes[mode];
  await assert.rejects(replace(projectDir, canonicalState(2)), { code: expected });
}

test("fenced replace rejects invalid lock capabilities before storage access", async () => {
  await assert.rejects(replaceFencedStateUnderLock(null, {}), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(replaceFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock capability must not be inspected"); },
  }), {}), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
});

test("fenced replace rebases a canonical candidate above local high-water and preserves generation", async () => {
  await withProject(async (projectDir) => {
    const { file, ledgerPath } = await seedFenced(projectDir);
    const candidate = replacementCandidate();
    const replaced = await replace(projectDir, candidate);
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));

    assertRebasedReplacement(replaced, ledger);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), replaced);
    assert.deepEqual(await replace(projectDir, candidate), replaced);
    assert.deepEqual(await readFencedState(projectDir), replaced);
  });
});

test("replace checkpoint is invalidated durably before installing a replacement", async () => {
  await withProject(async (projectDir) => {
    const { file, ledgerPath } = await seedFenced(projectDir);
    const recovered = await recoverCanonicalState(projectDir, file);
    assert.ok(JSON.parse(await fs.readFile(ledgerPath, "utf8")).last_recovery);
    const candidate = replacementCandidate();

    await assert.rejects(replace(projectDir, candidate, { faultAt: "after-pending" }), /injected failure/);
    const pending = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.equal(pending.last_recovery, undefined);
    assert.ok(pending.replace_pending);
    const replaced = await readFencedState(projectDir);
    assert.equal(replaced.nodes.T1.title, "restored payload");
    assert.equal(JSON.parse(await fs.readFile(ledgerPath, "utf8")).replace_pending, null);
    assert.notDeepEqual(replaced, recovered);
    assert.deepEqual(await readFencedState(projectDir), replaced);
  });
});

test("fenced replace resumes from exact source or destination across durable crash points", async (t) => {
  for (const faultAt of ["before-stage", "after-stage", "before-pending", "after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"]) {
    await runProjectSubtest(t, faultAt, (projectDir) => runReplaceCrash(projectDir, faultAt));
  }
});

test("fenced replace fails closed for divergent ledger, state, or adulterated stage", async (t) => {
  for (const alteration of ["state", "stage", "ledger"]) {
    await runProjectSubtest(t, alteration, (projectDir) => runReplaceAlteration(projectDir, alteration));
  }
});

function sha(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}


test("fenced replace refuses absent/corrupt ledger and invalid current fenced state", async (t) => {
  for (const mode of ["absent", "corrupt", "state"]) {
    await runProjectSubtest(t, mode, (projectDir) => runMissingOrCorruptLedger(projectDir, mode));
  }
});

test("fenced replace rejects unsupported candidates before changing durable files", async () => {
  await withProject(async (projectDir) => {
    const { file, ledgerPath } = await seedFenced(projectDir);
    const beforeState = await fs.readFile(file, "utf8");
    const beforeLedger = await fs.readFile(ledgerPath, "utf8");
    await assert.rejects(replace(projectDir, { version: 999 }), { code: "CLIMIER_UNSUPPORTED_SOURCE_VERSION" });
    assert.equal(await fs.readFile(file, "utf8"), beforeState);
    assert.equal(await fs.readFile(ledgerPath, "utf8"), beforeLedger);
  });
});
