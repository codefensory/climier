import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
  writeCanonicalState,
} from "./helpers.ts";

const TAKE = "./cli/commands/take.ts";
const BUILTINS = "./application/operations/builtins.ts";
const MUTATE = "./kernel/mutate.ts";

type Policy = { pluginId: string; projectConfig: Record<string, unknown> };
type Authorization = {
  action?: string;
  actor?: string;
  target: { previous_owner?: string; [key: string]: unknown };
};
type TestError = { code?: string; details?: Record<string, unknown> };

async function fixture({ policy = { pluginId: "policy-fixture", projectConfig: {} }, decision = "allow" }: {
  policy?: Policy | null;
  decision?: string | ((args: Authorization) => { decision: string });
} = {}) {
  const projectDir = await createTempProject();
  await writeCanonicalState(projectDir, {
    version: 1,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "task",
        initiative: "i",
        status: "in_progress",
        claim: { by: "alice", at: "2026-09-26T00:00:00.000Z" },
        revision: 1,
      },
    },
    edges: [],
    initiatives: { i: { desc: "initiative", created_at: "2026-09-26T00:00:00.000Z" } },
    log: [],
    revision: 1,
  });
  const [{ default: take }, { createBuiltinOperationRegistry }, { mutate }] = await Promise.all([
    importFresh(TAKE),
    importFresh(BUILTINS),
    importFresh(MUTATE),
  ]);
  const authorization: Authorization[] = [];
  const source = {
    registry: createBuiltinOperationRegistry(),
    mutate,
    async loadApplicablePolicy() {
      return policy;
    },
    async authorizeAction(args) {
      authorization.push(args);
      return typeof decision === "function" ? decision(args) : { decision };
    },
  };
  return { projectDir, take, source, authorization };
}

async function callTake(state, actor) {
  return state.take({
    positional: ["T1"],
    flags: { as: actor },
    projectDir: state.projectDir,
    source: state.source,
  });
}

test("CLI take uses Application Operations and authorizes plan-derived takeover", async () => {
  const state = await fixture();
  try {
    const result = await callTake(state, "bob");

    assert.equal(state.authorization.length, 1);
    assert.equal(state.authorization[0].action, "task.takeover");
    assert.equal(state.authorization[0].actor, "bob");
    assert.equal(state.authorization[0].target.previous_owner, "alice");
    assert.equal(result.node.claim.by, "bob");
    assert.equal(result.freshly_claimed, true);

    const after = await readState(state.projectDir);
    assert.equal(after.nodes.T1.claim.by, "bob");
    assert.equal(after.log.at(-1).action, "take");
    assert.equal(after.log.at(-1).previous_owner, "alice");
    assert.equal(after.log.at(-1).agent, "bob");
  } finally {
    await rmTempProject(state.projectDir);
  }
});

test("CLI take without policy preserves ALREADY_CLAIMED and does not mutate", async () => {
  const state = await fixture({ policy: null });
  try {
    const before = await readState(state.projectDir);
    await assert.rejects(callTake(state, "bob"), (error) => {
      const failure = error as TestError;
      return failure.code === "ALREADY_CLAIMED" && failure.details?.owner === "alice";
    });
    const after = await readState(state.projectDir);
    assert.deepEqual(after.nodes.T1, before.nodes.T1);
    assert.deepEqual(after.log, before.log);
    assert.equal(state.authorization.length, 0);
  } finally {
    await rmTempProject(state.projectDir);
  }
});

test("CLI take with policy abstain preserves ALREADY_CLAIMED and does not mutate", async () => {
  const state = await fixture({ decision: "abstain" });
  try {
    const before = await readState(state.projectDir);
    await assert.rejects(callTake(state, "bob"), (error) => {
      const failure = error as TestError;
      return failure.code === "ALREADY_CLAIMED" && failure.details?.owner === "alice";
    });
    const after = await readState(state.projectDir);
    assert.deepEqual(after.nodes.T1, before.nodes.T1);
    assert.deepEqual(after.log, before.log);
    assert.equal(state.authorization[0].action, "task.takeover");
  } finally {
    await rmTempProject(state.projectDir);
  }
});

test("CLI take with policy deny preserves POLICY_DENIED and does not mutate", async () => {
  const state = await fixture({ decision: "deny" });
  try {
    const before = await readState(state.projectDir);
    await assert.rejects(callTake(state, "bob"), (error) => {
      const failure = error as TestError;
      return failure.code === "POLICY_DENIED" && failure.details?.action === "task.takeover";
    });
    const after = await readState(state.projectDir);
    assert.deepEqual(after.nodes.T1, before.nodes.T1);
    assert.deepEqual(after.log, before.log);
    assert.equal(state.authorization[0].action, "task.takeover");
  } finally {
    await rmTempProject(state.projectDir);
  }
});

test("same-actor CLI take is idempotent and never treats identity as authorization", async () => {
  const state = await fixture();
  try {
    const before = await readState(state.projectDir);
    const result = await callTake(state, "alice");
    const after = await readState(state.projectDir);
    assert.equal(result.freshly_claimed, false);
    assert.equal(state.authorization.length, 0);
    assert.deepEqual(after.nodes.T1, before.nodes.T1);
    assert.deepEqual(after.log, before.log);
  } finally {
    await rmTempProject(state.projectDir);
  }
});
