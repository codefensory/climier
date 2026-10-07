import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.ts";
import { stateFile } from "../src/storage/state.ts";
import { withLock, assertActiveLockContext } from "../src/storage/lock.ts";
import {
  bootstrapFencedState,
  bootstrapFencedStateUnderLock,
  commitFencedStateUnderLock,
  ledgerFile,
  readFencedState,
  readFencedStateUnderLock,
} from "../src/storage/ledger.ts";
import { syncDirectory } from "../src/storage/ledger/stages.ts";

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

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

test("directory sync is skipped on Windows, where directory handles cannot be fsynced", async () => {
  await withProject(async (projectDir) => {
    await assert.doesNotReject(syncDirectory(path.join(projectDir, "missing"), "win32"));
  });
});

function rejectAfterTimeout(message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 1000));
}

async function pathExists(filePath) {
  return fs.stat(filePath).then(() => false, () => true);
}

function allNodesAtMostRevision(state: TestState, revision: number) {
  return Object.values(state.nodes).every((node) => node.revision <= revision);
}

function commitActionCount(state: TestState) {
  return state.log.filter((entry) => entry.action === "commit").length;
}

function assertLockContexts(context, first, second) {
  assert.equal(assertActiveLockContext(context, first), true);
  assert.throws(() => assertActiveLockContext(context, second), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  assert.throws(() => assertActiveLockContext({}), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
}

async function commitWhileLockHeld(projectDir, candidate) {
  return withLock(projectDir, (lockContext) => commitFencedStateUnderLock(lockContext, candidate));
}

async function readCommitUnderHeldLock(projectDir) {
  return withLock(projectDir, (lockContext) => readFencedStateUnderLock(lockContext));
}

async function runProjectSubtest(t, label, fn) {
  await t.test(label, () => withProject(fn));
}

function nextCandidate(state: TestState, revision = state.revision + 1): TestState {
  return {
    ...state,
    revision,
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, { ...node, revision }])),
    log: [...state.log, { action: "commit", revision }],
  };
}

async function commit(projectDir, candidate, options = {}) {
  return withLock(projectDir, (lockContext) =>
    commitFencedStateUnderLock(lockContext, candidate, options));
}

async function readUnderLock(projectDir, options = {}) {
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
      assertLockContexts(context, first, second);
    });
    assert.throws(() => assertActiveLockContext(expiredContext, first), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  } finally {
    await rmTempProject(first);
    await rmTempProject(second);
  }
});

test("fenced read rejects absent and forged capabilities before storage access", async () => {
  await assert.rejects(readFencedStateUnderLock(null as unknown as object), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
  await assert.rejects(readFencedStateUnderLock(new Proxy({}, {
    get() { throw new Error("forged lock context must not be inspected"); },
  })), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
});

test("fenced read requires an active capability and reads without reacquiring the held lock", async () => {
  const first = await createTempProject();
  const second = await createTempProject();
  try {
    const expected = asTestState(await bootstrapFencedState(first));
    let expiredContext;
    await withLock(first, async (lockContext) => {
      expiredContext = lockContext;
      const result = asTestState(await Promise.race([
        readFencedStateUnderLock(lockContext),
        rejectAfterTimeout("read reacquired the held lock"),
      ]));
      assert.deepEqual(result, expected);
      const publicRead = asTestState(await Promise.race([
        readFencedState(first),
        rejectAfterTimeout("public read reacquired the held lock"),
      ]));
      assert.deepEqual(publicRead, expected);
    });
    await assert.rejects(readFencedStateUnderLock(expiredContext), { code: "CLIMIER_INVALID_LOCK_CONTEXT" });
    await withLock(second, async (lockContext) => {
      assert.equal(await readFencedStateUnderLock(lockContext), null);
    });
  } finally {
    await rmTempProject(first);
    await rmTempProject(second);
  }
});

test("fenced read rejects malformed, downgraded, generation, and revision-mismatched state", async (t) => {
  const cases: Array<[string, (state: TestState) => Record<string, unknown>]> = [
    ["degraded schema", (state) => ({ ...state, version: 5 })],
    ["missing generation", (state) => {
      const { fence_generation: _generation, ...degraded } = state;
      return degraded;
    }],
    ["different generation", (state) => ({ ...state, fence_generation: state.fence_generation + 1 })],
    ["different revision", (state) => ({ ...state, revision: state.revision + 1 })],
  ];
  for (const [label, alter] of cases) {
    await runProjectSubtest(t, label, async (projectDir) => {
      await bootstrapFencedState(projectDir);
      const state = asTestState(await readFencedState(projectDir));
      await fs.writeFile(stateFile(projectDir), `${JSON.stringify(alter(state), null, 2)}\n`, "utf8");
      await assert.rejects(readUnderLock(projectDir), { code: label === "degraded schema" ? "CLIMIER_INCOMPATIBLE_VERSION" : "CLIMIER_LEDGER_STATE_MISMATCH" });
    });
  }
});

test("fenced commit requires an active capability and commits under the existing lock", async () => {
  await assert.rejects(
    commitFencedStateUnderLock(null as unknown as object, {}),
    { code: "CLIMIER_INVALID_LOCK_CONTEXT" },
  );

  await withProject(async (projectDir) => {
    const initial = asTestState(await bootstrapFencedState(projectDir));
    const candidate = nextCandidate(initial);
    const result = asTestState(await Promise.race([
      commitWhileLockHeld(projectDir, candidate),
      rejectAfterTimeout("commit reacquired the held lock"),
    ]));

    assert.equal(result.revision, candidate.revision);
    assert.deepEqual(await readFencedState(projectDir), candidate);
    assert.equal(await pathExists(path.join(path.dirname(stateFile(projectDir)), ".lock")), true);
  });
});

test("fenced commit rejects created or modified nodes without advancing their revisions", async () => {
  await withProject(async (projectDir) => {
    const current = asTestState(await bootstrapFencedState(projectDir));
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
    const current = asTestState(await withLock(projectDir, (context) => bootstrapFencedStateUnderLock(context, {
      version: 1, nodes: { T1: { id: "T1", revision: 3 } }, edges: [], initiatives: {}, log: [], revision: 2,
    })));
    const populated = {
      ...current,
      nodes: { T1: { id: "T1", revision: current.revision } },
    };
    const candidates = [
      { ...nextCandidate(current), fence_generation: current.fence_generation + 1 },
      { ...nextCandidate(current), revision: current.revision },
      { ...nextCandidate(populated), nodes: { ...nextCandidate(populated).nodes, T1: { ...populated.nodes.T1, revision: populated.nodes.T1.revision - 1 } } },
      { ...nextCandidate(populated), nodes: { ...nextCandidate(populated).nodes, T1: { ...populated.nodes.T1, revision: populated.revision + 2 } } },
    ];
    for (const candidate of candidates) {
      await assert.rejects(commit(projectDir, candidate), /generation|monotonic|revision/i);
      assert.deepEqual(await readFencedState(projectDir), current);
    }
  });
});

test("fenced commit reserves at least all candidate revisions and persists exact state/log bytes", async () => {
  await withProject(async (projectDir) => {
    const current = asTestState(await bootstrapFencedState(projectDir));
    const candidate = nextCandidate(current, current.revision + 3);
    const result = asTestState(await commit(projectDir, candidate));
    const raw = await fs.readFile(stateFile(projectDir), "utf8");
    const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));

    assert.equal(result.revision, candidate.revision);
    assert.deepEqual(JSON.parse(raw), candidate);
    assert.equal(ledger.high_water_revision, candidate.revision);
    assert.equal(ledger.commit_pending, null);
    assert.equal(allNodesAtMostRevision(candidate, candidate.revision), true);
    assert.equal(commitActionCount(candidate), 1);
  });
});

test("commit crash before durable stage or pending leaves source state and ledger unchanged", async (t) => {
  for (const faultAt of ["before-stage", "after-stage", "before-pending"]) {
    await runProjectSubtest(t, faultAt, async (projectDir) => {
      await bootstrapFencedState(projectDir);
      const current = asTestState(await readFencedState(projectDir));
      const sourceRaw = await fs.readFile(stateFile(projectDir), "utf8");
      const ledgerRaw = await fs.readFile(ledgerFile(projectDir), "utf8");
      await assert.rejects(commit(projectDir, nextCandidate(current), { faultAt }), /injected failure/);
      assert.equal(await fs.readFile(stateFile(projectDir), "utf8"), sourceRaw);
      assert.equal(await fs.readFile(ledgerFile(projectDir), "utf8"), ledgerRaw);
      assert.deepEqual(await readFencedState(projectDir), current);
    });
  }
});

test("commit recovery resumes exact source or destination fingerprints idempotently", async (t) => {
  for (const faultAt of ["after-pending", "before-state-rename", "after-state-rename", "before-ledger-clear"]) {
    await runProjectSubtest(t, faultAt, async (projectDir) => {
      await bootstrapFencedState(projectDir);
      const current = asTestState(await readFencedState(projectDir));
      const candidate = nextCandidate(current);
      await assert.rejects(commit(projectDir, candidate, { faultAt }), /injected failure/);

      const pending = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending;
      assert.ok(pending);
      assert.equal(pending.source_sha256.length, 64);
      assert.equal(pending.destination_sha256.length, 64);
      assert.equal(pending.high_water_revision, candidate.revision);
      assert.equal(typeof pending.stage_id, "string");

      const recovered = asTestState(await readCommitUnderHeldLock(projectDir));
      assert.deepEqual(recovered, candidate);
      assert.deepEqual(await readUnderLock(projectDir), candidate);
      const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
      const destinationRaw = await fs.readFile(stateFile(projectDir), "utf8");
      assert.equal(ledger.commit_pending, null);
      assert.ok(ledger.high_water_revision >= candidate.revision);
      assert.equal(pending.destination_sha256, sha256(destinationRaw));
      assert.equal(commitActionCount(recovered), 1);
    });
  }
});

test("commit recovery fails closed when state diverges from both pending fingerprints", async () => {
  await withProject(async (projectDir) => {
    const current = asTestState(await bootstrapFencedState(projectDir));
    await assert.rejects(commit(projectDir, nextCandidate(current), { faultAt: "after-pending" }), /injected failure/);
    const changed = { ...current, log: [...current.log, { action: "unrelated" }] };
    await fs.writeFile(stateFile(projectDir), `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    await assert.rejects(readUnderLock(projectDir), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
    assert.ok(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending);
  });
});

test("commit recovery fails closed when the durable ledger advances beyond the pending reservation", async () => {
  await withProject(async (projectDir) => {
    const current = asTestState(await bootstrapFencedState(projectDir));
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
    await runProjectSubtest(t, stageState, async (projectDir) => {
      await bootstrapFencedState(projectDir);
      const current = asTestState(await readFencedState(projectDir));
      await assert.rejects(commit(projectDir, nextCandidate(current), { faultAt: "after-pending" }), /injected failure/);
      const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
      const stage = path.join(path.dirname(stateFile(projectDir)), `.commit-stage-${ledger.commit_pending.stage_id}`);
      if (stageState === "altered") {await fs.writeFile(stage, "not the staged destination", "utf8");}
      else {await fs.unlink(stage);}

      await assert.rejects(readUnderLock(projectDir), { code: "CLIMIER_LEDGER_FINGERPRINT_MISMATCH" });
      assert.ok(JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8")).commit_pending);
    });
  }
});
