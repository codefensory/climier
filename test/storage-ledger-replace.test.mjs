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
  readFencedState,
  replaceFencedStateUnderLock,
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

async function seedFenced(projectDir) {
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(legacyState(), null, 2)}\n`, "utf8");
  await bootstrapFencedState(projectDir);
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

test("fenced replace rejects invalid lock capabilities before storage access", async () => {
  await assert.rejects(replaceFencedStateUnderLock(null, {}), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(replaceFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock capability must not be inspected"); },
  }), {}), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
});

test("fenced replace rebases a v5 candidate above local high-water and preserves generation", async () => {
  await withProject(async (projectDir) => {
    const { file, ledgerPath } = await seedFenced(projectDir);
    const candidate = legacyState(3);
    candidate.version = 5;
    candidate.fence_generation = 99;
    candidate.nodes.T1.revision = 2;
    candidate.nodes.T2.revision = 4;
    candidate.nodes.T1.title = "restored payload";
    candidate.log = [{ action: "restore-payload" }];

    const replaced = await replace(projectDir, candidate);
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.equal(replaced.version, 5);
    assert.equal(replaced.fence_generation, 7);
    assert.equal(replaced.revision, 41);
    assert.ok(Object.values(replaced.nodes).every((node) => node.revision === 41));
    assert.equal(replaced.nodes.T1.title, "restored payload");
    assert.deepEqual(replaced.log, [{ action: "restore-payload" }]);
    assert.equal(ledger.fence_generation, 7);
    assert.equal(ledger.high_water_revision, 41);
    assert.equal(ledger.replace_pending, null);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), replaced);
    assert.deepEqual(await replace(projectDir, candidate), replaced);
    assert.deepEqual(await readFencedState(projectDir), replaced);
  });
});

test("fenced replace resumes from exact source or destination across durable crash points", async (t) => {
  for (const faultAt of ["before-stage", "after-stage", "before-pending", "after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"]) {
    await t.test(faultAt, async () => withProject(async (projectDir) => {
      const { file, ledgerPath } = await seedFenced(projectDir);
      const sourceRaw = await fs.readFile(file, "utf8");
      const candidate = legacyState(3);
      candidate.log = [{ action: "crash-replace" }];
      await assert.rejects(replace(projectDir, candidate, { faultAt }), /injected failure/);
      const pendingLedger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
      const pending = pendingLedger.replace_pending;
      const pendingDurable = ["after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"].includes(faultAt);
      assert.equal(Boolean(pending), pendingDurable);
      if (!pendingDurable) {
        assert.equal(pendingLedger.high_water_revision, 40);
        assert.equal(await fs.readFile(file, "utf8"), sourceRaw);
      } else {
        assert.equal(pending.source_sha256, sha(sourceRaw));
        assert.match(pending.destination_sha256, /^[a-f0-9]{64}$/);
        const wrongRetry = { ...candidate, log: [{ action: "different-payload" }] };
        await assert.rejects(replace(projectDir, wrongRetry), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
      }
      const replaced = pendingDurable
        ? await readFencedState(projectDir)
        : await replace(projectDir, candidate);
      assert.equal(replaced.version, 5);
      assert.equal(replaced.fence_generation, 7);
      assert.equal(replaced.revision, 41);
      assert.equal(JSON.parse(await fs.readFile(ledgerPath, "utf8")).replace_pending, null);
      assert.deepEqual(await replace(projectDir, candidate), replaced);
    }));
  }
});

test("fenced replace fails closed for divergent ledger, state, or adulterated stage", async (t) => {
  for (const alteration of ["state", "stage", "ledger"]) {
    await t.test(alteration, async () => withProject(async (projectDir) => {
      const { file, ledgerPath } = await seedFenced(projectDir);
      const candidate = legacyState(3);
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
    }));
  }
});

function sha(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}


test("fenced replace refuses absent/corrupt ledger and invalid current fenced state", async (t) => {
  for (const mode of ["absent", "corrupt", "state"]) {
    await t.test(mode, async () => withProject(async (projectDir) => {
      const { file, ledgerPath } = await seedFenced(projectDir);
      if (mode === "absent") await fs.unlink(ledgerPath);
      else if (mode === "corrupt") await fs.writeFile(ledgerPath, "{broken", "utf8");
      else {
        const state = JSON.parse(await fs.readFile(file, "utf8"));
        state.fence_generation += 1;
        await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      }
      await assert.rejects(replace(projectDir, legacyState(2)), mode === "absent"
        ? { code: "CLIMIER_LEDGER_MISSING" }
        : mode === "corrupt" ? { code: "CLIMIER_CORRUPT_LEDGER" } : { code: "CLIMIER_LEDGER_STATE_MISMATCH" });
    }));
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
