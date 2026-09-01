import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
  writeState,
} from "./helpers.mjs";

function baseState() {
  return {
    version: 4,
    revision: 0,
    initiatives: { work: { desc: "work", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "before",
        initiative: "work",
        status: "open",
        revision: 1,
      },
    },
    edges: [],
    log: [],
  };
}

function updateProvider() {
  return {
    async prepare({ snapshot }) {
      return { target: { id: "T1", kind: "resolvable", subkind: "task" } };
    },
    async apply({ tx }) {
      tx.updateNode("T1", { title: "after" });
      return { result: { ok: true } };
    },
  };
}

async function setup() {
  const dir = await createTempProject();
  await writeState(dir, baseState());
  return dir;
}

test("kernel mutation increments global state revision exactly once for an effective commit", async () => {
  const { mutate } = await importFresh("./kernel/mutate.mjs");
  const dir = await setup();
  try {
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.update", actor: "alice", input: {} },
      provider: updateProvider(),
    });
    assert.equal(out.idempotent, false);
    assert.equal((await readState(dir)).revision, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel mutation leaves global revision unchanged for a no-op", async () => {
  const { mutate } = await importFresh("./kernel/mutate.mjs");
  const dir = await setup();
  try {
    const out = await mutate({
      projectDir: dir,
      request: { action: "task.noop", actor: "alice", input: {} },
      provider: {
        async prepare() { return { target: { id: "T1" } }; },
        async apply() { return { result: { ok: true } }; },
      },
    });
    assert.equal(out.idempotent, true);
    assert.equal((await readState(dir)).revision, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel mutation rejects stale global CAS before policy/apply and does not persist", async () => {
  const { mutate } = await importFresh("./kernel/mutate.mjs");
  const dir = await setup();
  try {
    let policyCalls = 0;
    let applyCalls = 0;
    const before = await readState(dir);
    await assert.rejects(
      mutate({
        projectDir: dir,
        request: { action: "task.update", actor: "alice", input: {}, if_state_revision: 7 },
        provider: {
          async prepare() { return { target: { id: "T1" } }; },
          async apply() { applyCalls += 1; return { result: {} }; },
        },
        policyAction: {
          async decide() { policyCalls += 1; return { decision: "allow" }; },
        },
      }),
      (error) => error.code === "STATE_REVISION_CONFLICT" &&
        error.details.expected === 7 && error.details.actual === 0,
    );
    assert.equal(policyCalls, 0);
    assert.equal(applyCalls, 0);
    assert.deepEqual(await readState(dir), before);
  } finally {
    await rmTempProject(dir);
  }
});

test("application operations projects if_state_revision onto the kernel request", async () => {
  const { executeOperation } = await importFresh("./application/operations/execute.mjs");
  let captured;
  const provider = { prepare() {}, apply() {} };
  await executeOperation({
    projectDir: "/project",
    actor: "alice",
    operation: "task.update",
    input: { id: "T1", if_state_revision: 0 },
    source: {
      registry: { lookup() { return { provider }; } },
      mutate(request) { captured = request; return { ok: true }; },
    },
  });
  assert.deepEqual(captured.request, {
    action: "task.update",
    actor: "alice",
    input: { id: "T1", if_state_revision: 0 },
    if_state_revision: 0,
  });
});
