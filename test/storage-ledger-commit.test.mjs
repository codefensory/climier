import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { stateFile } from "../src/storage/state.mjs";
import { withLock, assertActiveLockContext } from "../src/storage/lock.mjs";
import {
  bootstrapFencedState,
  commitFencedStateUnderLock,
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
    log: [{ action: "seed" }],
    revision: 10,
  };
}

async function seedState(projectDir) {
  const file = stateFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(preFenceState(), null, 2)}\n`, "utf8");
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

function nextCandidate(state, revision = state.revision + 1) {
  return {
    ...state,
    revision,
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, { ...node, revision }])),
    log: [...state.log, { action: "commit", revision }],
  };
}

async function commit(projectDir, candidate, options) {
  return withLock(projectDir, (lockContext) =>
    commitFencedStateUnderLock(lockContext, candidate, options));
}

async function readUnderLock(projectDir, options) {
  return withLock(projectDir, (lockContext) =>
    readFencedStateUnderLock(lockContext, options));
}

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

test("lock context is opaque, active only for its project and invocation", async () => {
  const first = await createTempProject();
  const second = await createTempProject();
  try {
    let expiredContext;
    await withLock(first, async (context) => {
      expiredContext = context;
      assert.equal(assertActiveLockContext(context, first), true);
      assert.throws(() => assertActiveLockContext(context, second), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
      assert.throws(() => assertActiveLockContext({}), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
    });
    assert.throws(() => assertActiveLockContext(expiredContext, first), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  } finally {
    await rmTempProject(first);
    await rmTempProject(second);
  }
});

test("fenced read rejects absent and forged capabilities before storage access", async () => {
  await assert.rejects(readFencedStateUnderLock(null), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(readFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock context must not be inspected"); },
  })), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
});

test("fenced read requires an active capability and reads without reacquiring the held lock", async () => {
  const first = await createTempProject();
  const second = await createTempProject();
  try {
    await seedState(first);
    const expected = await bootstrapFencedState(first);
    let expiredContext;
    await withLock(first, async (lockContext) => {
      expiredContext = lockContext;
      const result = await Promise.race([
        readFencedStateUnderLock(lockContext),
        new Promise((_, reject) => setTimeout(() => reject(new Error("read reacquired the held lock")), 1000)),
      ]);
      assert.deepEqual(result, expected);
    });
    await assert.rejects(readFencedStateUnderLock(expiredContext), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
    await withLock(second, async (lockContext) => {
      await assert.rejects(readFencedStateUnderLock(lockContext), { code: "CLIMIER_LEDGER_MISSING" });
    });
  } finally {
    await rmTempProject(first);
    await rmTempProject(second);
  }
});

test("fenced read rejects malformed, downgraded, generation, and revision-mismatched state", async (t) => {
  const cases = [
    ["degraded schema", (state) => ({ ...state, version: 4 })],
    ["missing generation", (state) => {
      const { fence_generation: _generation, ...degraded } = state;
      return degraded;
    }],
    ["different generation", (state) => ({ ...state, fence_generation: state.fence_generation + 1 })],
    ["different revision", (state) => ({ ...state, revision: state.revision + 1 })],
  ];
  for (const [label, alter] of cases) {
    await t.test(label, async () => withProject(async (projectDir) => {
      await seedState(projectDir);
      const state = await bootstrapFencedState(projectDir);
      await fs.writeFile(stateFile(projectDir), `${JSON.stringify(alter(state), null, 2)}\n`, "utf8");
      await assert.rejects(readUnderLock(projectDir), { code: "CLIMIER_LEDGER_STATE_MISMATCH" });
    }));
  }
});

test("fenced commit requires an active capability and commits under the existing lock", async () => {
  await assert.rejects(
    commitFencedStateUnderLock(null, {}),
    { code: "CLIMIER_INVALID_LOCK_CONTEXT" },
  );

  await withProject(async (projectDir) => {
    await seedState(projectDir);
    const initial = await bootstrapFencedState(projectDir);
    const candidate = nextCandidate(initial);
    const result = await Promise.race([
      withLock(projectDir, (lockContext) => commitFencedStateUnderLock(lockContext, candidate)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("commit reacquired the held lock")), 1000)),
    ]);

    assert.equal(result.revision, candidate.revision);
    assert.deepEqual(await readFencedState(projectDir), candidate);
    assert.equal(await fs.stat(path.join(path.dirname(stateFile(projectDir)), ".lock")).then(() => false, () => true), true);
  });
});

test("fenced commit rejects created or modified nodes without advancing their revisions", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    const current = await bootstrapFencedState(projectDir);
    const created = nextCandidate(current);
    created.nodes.T3 = { id: "T3", revision: current.revision };
    const modified = nextCandidate(current);
    modified.nodes.T1 = { ...current.nodes.T1, title: "changed", revision: current.revision };
    await assert.rejects(commit(projectDir, created), /new node|revision/i);
    await assert.rejects(commit(projectDir, modified), /modified node|revision/i);
    assert.deepEqual(await readFencedState(projectDir), current);
  });
});

test("fenced commit preserves generation and requires strictly monotonic state and node revisions", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    const current = await bootstrapFencedState(projectDir);
    const candidates = [
      { ...nextCandidate(current), fence_generation: current.fence_generation + 1 },
      { ...nextCandidate(current), revision: current.revision },
      { ...nextCandidate(current), nodes: { ...nextCandidate(current).nodes, T1: { ...current.nodes.T1, revision: current.nodes.T1.revision - 1 } } },
      { ...nextCandidate(current), nodes: { ...nextCandidate(current).nodes, T1: { ...current.nodes.T1, revision: current.revision + 2 } } },
    ];
    for (const candidate of candidates) {
      await assert.rejects(commit(projectDir, candidate), /generation|monotonic|revision/i);
      assert.deepEqual(await readFencedState(projectDir), current);
    }
  });
});

test("fenced commit reserves at least all candidate revisions and persists exact state/log bytes", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    const current = await bootstrapFencedState(projectDir);
    const candidate = nextCandidate(current, current.revision + 3);
    candidate.nodes.T1.revision = candidate.revision - 1;
    const result = await commit(projectDir, candidate);
    const raw = await fs.readFile(stateFile(projectDir), "utf8");
    const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));

    assert.equal(result.revision, candidate.revision);
    assert.deepEqual(JSON.parse(raw), candidate);
    assert.equal(ledger.high_water_revision, candidate.revision);
    assert.equal(ledger.commit_pending, null);
    assert.equal(candidate.revision >= Math.max(...Object.values(candidate.nodes).map((node) => node.revision)), true);
    assert.equal(candidate.log.filter((entry) => entry.action === "commit").length, 1);
  });
});

test("commit crash before durable stage or pending leaves source state and ledger unchanged", async (t) => {
  for (const faultAt of ["before-stage", "after-stage", "before-pending"]) {
    await t.test(faultAt, async () => withProject(async (projectDir) => {
      await seedState(projectDir);
      const current = await bootstrapFencedState(projectDir);
      const sourceRaw = await fs.readFile(stateFile(projectDir), "utf8");
      const ledgerRaw = await fs.readFile(ledgerFile(projectDir), "utf8");
      await assert.rejects(commit(projectDir, nextCandidate(current), { faultAt }), /injected failure/);
      assert.equal(await fs.readFile(stateFile(projectDir), "utf8"), sourceRaw);
      assert.equal(await fs.readFile(ledgerFile(projectDir), "utf8"), ledgerRaw);
      assert.deepEqual(await readFencedState(projectDir), current);
    }));
  }
});

test("commit recovery resumes exact source or destination fingerprints idempotently", async (t) => {
  for (const faultAt of ["after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"]) {
    await t.test(faultAt, async () => withProject(async (projectDir) => {
      await seedState(projectDir);
      const current = await bootstrapFencedState(projectDir);
      const candidate = nextCandidate(current);
      await assert.rejects(commit(projectDir, candidate, { faultAt }), /injected failure/);

      const pending = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending;
      assert.ok(pending);
      assert.equal(pending.source_sha256.length, 64);
      assert.equal(pending.destination_sha256.length, 64);
      assert.equal(pending.high_water_revision, candidate.revision);
      assert.equal(typeof pending.stage_id, "string");

      const recovered = await readUnderLock(projectDir);
      assert.deepEqual(recovered, candidate);
      assert.deepEqual(await readUnderLock(projectDir), candidate);
      const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
      const destinationRaw = await fs.readFile(stateFile(projectDir), "utf8");
      assert.equal(ledger.commit_pending, null);
      assert.ok(ledger.high_water_revision >= candidate.revision);
      assert.equal(pending.destination_sha256, sha256(destinationRaw));
      assert.equal(recovered.log.filter((entry) => entry.action === "commit").length, 1);
    }));
  }
});

test("commit recovery fails closed when state diverges from both pending fingerprints", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    const current = await bootstrapFencedState(projectDir);
    await assert.rejects(commit(projectDir, nextCandidate(current), { faultAt: "after-pending" }), /injected failure/);
    const changed = { ...current, log: [...current.log, { action: "unrelated" }] };
    await fs.writeFile(stateFile(projectDir), `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    await assert.rejects(readUnderLock(projectDir), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
    assert.ok(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending);
  });
});

test("commit recovery fails closed when the durable ledger advances beyond the pending reservation", async () => {
  await withProject(async (projectDir) => {
    await seedState(projectDir);
    const current = await bootstrapFencedState(projectDir);
    await assert.rejects(commit(projectDir, nextCandidate(current), { faultAt: "after-pending" }), /injected failure/);
    const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
    ledger.high_water_revision += 1;
    await fs.writeFile(ledgerFile(projectDir), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

    await assert.rejects(readFencedState(projectDir), { code: "CLIMIER_INVALID_LEDGER" });
    assert.equal(JSON.parse(await fs.readFile(stateFile(projectDir), "utf8")).revision, current.revision);
  });
});

test("commit pending recovery rejects missing or altered durable stage without clearing pending", async (t) => {
  for (const stageState of ["missing", "altered"]) {
    await t.test(stageState, async () => withProject(async (projectDir) => {
      await seedState(projectDir);
      const current = await bootstrapFencedState(projectDir);
      await assert.rejects(commit(projectDir, nextCandidate(current), { faultAt: "after-pending" }), /injected failure/);
      const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
      const stage = path.join(path.dirname(stateFile(projectDir)), `.commit-stage-${ledger.commit_pending.stage_id}`);
      if (stageState === "altered") await fs.writeFile(stage, "not the staged destination", "utf8");
      else await fs.unlink(stage);

      await assert.rejects(readUnderLock(projectDir), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
      assert.ok(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending);
    }));
  }
});
