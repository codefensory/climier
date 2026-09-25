import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { readState, stateFile } from "../src/storage/state.mjs";
import { bootstrapFencedState, ledgerFile, readFencedState } from "../src/storage/ledger.mjs";

function preFenceState(version = 4) {
  return {
    version,
    nodes: { T1: { id: "T1", revision: 8 } },
    edges: [],
    initiatives: {},
    log: [],
    revision: 10,
  };
}

async function seedState(projectDir, state = preFenceState()) {
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return file;
}

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

test("readState delegates v5 state validation to the fenced ledger reader", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    const fenced = await bootstrapFencedState(projectDir);

    assert.deepEqual(await readState(projectDir), fenced);
    assert.deepEqual(await readState(projectDir), await readFencedState(projectDir));
  });
});

test("readState preserves v2-v4 compatibility and v2/v3 normalization", async () => {
  await withProject(async (projectDir) => {
    for (const version of [2, 3, 4]) {
      await seedState(projectDir, preFenceState(version));
      const state = await readState(projectDir);
      assert.equal(state.version, 4);
      assert.equal(state.revision, version === 4 ? 10 : 0);
    }
  });
});

test("readState fails closed when a v5 ledger is missing or corrupt", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    await bootstrapFencedState(projectDir);
    const ledger = ledgerFile(projectDir);

    await fs.unlink(ledger);
    await assert.rejects(readState(projectDir), { code: "CLIMIER_LEDGER_MISSING" });

    await fs.writeFile(ledger, "{broken", "utf8");
    await assert.rejects(readState(projectDir), { code: "CLIMIER_CORRUPT_LEDGER" });
  });
});

test("readState fails closed when a v5 state diverges from the ledger", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    await bootstrapFencedState(projectDir);
    const ledger = ledgerFile(projectDir);
    const changed = JSON.parse(await fs.readFile(ledger, "utf8"));
    changed.high_water_revision++;
    await fs.writeFile(ledger, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    await assert.rejects(readState(projectDir), { code: "CLIMIER_LEDGER_STATE_MISMATCH" });
  });
});

test("readState recovers only the exact pending migration source fingerprint", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-pending" }), /injected failure/);

    const recovered = await readState(projectDir);
    assert.equal(recovered.version, 5);
    assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).migration_pending, null);
  });

  await withProject(async (projectDir) => {
    await seedState(projectDir);
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-state-rename" }), /injected failure/);

    const recovered = await readState(projectDir);
    assert.equal(recovered.version, 5);
    assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).migration_pending, null);
  });

  await withProject(async (projectDir) => {
    const file = await seedState(projectDir);
    await assert.rejects(bootstrapFencedState(projectDir, { faultAt: "after-pending" }), /injected failure/);
    const changed = preFenceState();
    changed.nodes.T1.revision++;
    await fs.writeFile(file, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    await assert.rejects(readState(projectDir), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
  });
});

test("readState resumes an exact pending fenced commit", async () => {
  await withProject(async (projectDir) => {
    const { withLock } = await import("../src/storage/lock.mjs");
    const { commitFencedStateUnderLock } = await import("../src/storage/ledger.mjs");
    await seedState(projectDir);
    const current = await bootstrapFencedState(projectDir);
    const candidate = {
      ...current,
      revision: current.revision + 1,
      nodes: Object.fromEntries(Object.entries(current.nodes).map(([id, node]) => [id, { ...node, revision: current.revision + 1 }])),
      log: [...current.log, { action: "commit" }],
    };
    await assert.rejects(
      withLock(projectDir, (lockContext) => commitFencedStateUnderLock(lockContext, candidate, { faultAt: "after-pending" })),
      /injected failure/,
    );

    assert.deepEqual(await readState(projectDir), candidate);
    assert.equal(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending, null);
  });
});
