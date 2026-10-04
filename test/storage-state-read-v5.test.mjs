import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { readState, stateFile } from "../src/storage/state.mjs";
import { bootstrapFencedState, ledgerFile, readFencedState } from "../src/storage/ledger.mjs";

function legacyState(version) {
  return {
    version,
    nodes: { T1: { id: "T1", revision: 8 } },
    edges: [],
    initiatives: {},
    log: [],
    revision: 10,
    ...(version === 5 ? { fence_generation: 1 } : {}),
  };
}

async function seedCanonicalState(projectDir) {
  await bootstrapFencedState(projectDir);
  return stateFile(projectDir);
}

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

function nextCandidate(current) {
  const revision = current.revision + 1;
  const nodes = Object.fromEntries(Object.entries(current.nodes).map(([id, node]) => [id, { ...node, revision }]));
  return { ...current, revision, nodes, log: [...current.log, { action: "commit" }] };
}

async function interruptedCommit(projectDir, candidate) {
  const { withLock } = await import("../src/storage/lock.mjs");
  const { commitFencedStateUnderLock } = await import("../src/storage/ledger.mjs");
  return withLock(projectDir, (lockContext) => commitFencedStateUnderLock(lockContext, candidate, { faultAt: "after-pending" }));
}

test("readState delegates canonical state validation to the fenced ledger reader", async () => {
  await withProject(async (projectDir) => {
    await seedCanonicalState(projectDir);
    const fenced = await readFencedState(projectDir);

    assert.deepEqual(await readState(projectDir), fenced);
  });
});

test("readState rejects versions 2 through 5 and directs explicit migration", async (t) => {
  for (const version of [2, 3, 4, 5]) {
    await t.test(`version ${version}`, async () => {
      await withProject(async (projectDir) => {
        await seedCanonicalState(projectDir);
        await fs.writeFile(stateFile(projectDir), `${JSON.stringify(legacyState(version), null, 2)}\n`, "utf8");
        await assert.rejects(readState(projectDir), (error) => error.code === "CLIMIER_INCOMPATIBLE_VERSION" && /climier migrate/i.test(error.message));
      });
    });
  }
});

test("readState fails closed when a canonical ledger is missing or corrupt", async () => {
  await withProject(async (projectDir) => {
    await seedCanonicalState(projectDir);
    const ledger = ledgerFile(projectDir);

    await fs.unlink(ledger);
    await assert.rejects(readState(projectDir), { code: "CLIMIER_NONCANONICAL_STATE" });

    await fs.writeFile(ledger, "{broken", "utf8");
    await assert.rejects(readState(projectDir), { code: "CLIMIER_CORRUPT_LEDGER" });
  });
});

test("readState fails closed when canonical state diverges from the ledger", async () => {
  await withProject(async (projectDir) => {
    await seedCanonicalState(projectDir);
    const ledger = ledgerFile(projectDir);
    const changed = JSON.parse(await fs.readFile(ledger, "utf8"));
    changed.high_water_revision++;
    await fs.writeFile(ledger, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    await assert.rejects(readState(projectDir), { code: "CLIMIER_LEDGER_STATE_MISMATCH" });
  });
});

test("readState recovers exact pending bootstrap", async () => {
  await withProject(async (projectDir) => {
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-pending" }), /injected failure/);

    const recovered = await readState(projectDir);
    assert.equal(recovered.version, 1);
    assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).bootstrap_pending, null);
  });

  await withProject(async (projectDir) => {
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-state-create" }), /injected failure/);

    const recovered = await readState(projectDir);
    assert.equal(recovered.version, 1);
    assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).bootstrap_pending, null);
  });
});

test("readState resumes an exact pending fenced commit", async () => {
  await withProject(async (projectDir) => {
    await seedCanonicalState(projectDir);
    const current = await readFencedState(projectDir);
    const candidate = nextCandidate(current);
    await assert.rejects(interruptedCommit(projectDir, candidate), /injected failure/);

    assert.deepEqual(await readState(projectDir), candidate);
    assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending, null);
  });
});
