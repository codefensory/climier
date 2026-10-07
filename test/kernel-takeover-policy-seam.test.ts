import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
  writeCanonicalState,
} from "./helpers.ts";

const EXECUTE = "../src/application/operations/execute.ts";
const BUILTINS = "../src/application/operations/builtins.ts";
const MUTATE = "../src/kernel/mutate.ts";

type Policy = { pluginId: string };
type Decision = { decision: string; reason?: string };
type Source = {
  registry: unknown;
  mutate: unknown;
  loadApplicablePolicy?: () => Promise<Policy | undefined>;
  authorizeAction?: (args: { action: string }) => Promise<Decision>;
};
type ExecuteOperation = (args: Record<string, unknown>) => Promise<{ result: { freshly_claimed: boolean } }>;
type ErrorLike = { code?: string; details?: { owner?: string; action?: string } };
function errorLike(error: unknown): ErrorLike {
  return (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
}

async function fixture() {
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
  const [{ executeOperation: rawExecuteOperation }, { createBuiltinOperationRegistry }, { mutate }] = await Promise.all([
    importFresh(EXECUTE),
    importFresh(BUILTINS),
    importFresh(MUTATE),
  ]);
  const executeOperation = rawExecuteOperation as ExecuteOperation;
  const source: Source = {
    registry: createBuiltinOperationRegistry(),
    mutate,
  };
  return { projectDir, executeOperation, source };
}

async function attemptTakeover({ projectDir, executeOperation, source, policy, authorizeAction, optIn = true }: { projectDir: string; executeOperation: ExecuteOperation; source: Source; policy?: Policy; authorizeAction?: (args: { action: string }) => Promise<Decision>; optIn?: boolean }) {
  if (policy !== undefined) {
    source.loadApplicablePolicy = async () => policy;
    source.authorizeAction = authorizeAction;
  }
  return executeOperation({
    projectDir,
    actor: "bob",
    operation: "task.take",
    input: { id: "T1", at: "2026-09-26T01:00:00.000Z" },
    policyActionFromPlan: optIn,
    source,
  });
}

test("opt-in takeover policy is selected from the locked plan and abstain preserves the claim", async () => {
  const state = await fixture();
  try {
    const before = await readState(state.projectDir);
    let actionSeen;
    await assert.rejects(
      attemptTakeover({
        ...state,
        policy: { pluginId: "policy-fixture" },
        authorizeAction: async ({ action }) => {
          actionSeen = action;
          return { decision: "abstain" };
        },
      }),
      (error) => errorLike(error).code === "ALREADY_CLAIMED",
    );
    assert.equal(actionSeen, "task.takeover");
    const after = await readState(state.projectDir);
    assert.deepEqual(after.nodes.T1, before.nodes.T1);
    assert.deepEqual(after.log, before.log);
  } finally {
    await rmTempProject(state.projectDir);
  }
});

test("api.core.run defaults preserve the task.take policy action on takeover", async () => {
  const { projectDir, executeOperation, source } = await fixture();
  try {
    const actions: string[] = [];
    source.loadApplicablePolicy = async () => ({ pluginId: "policy-fixture" });
    source.authorizeAction = async ({ action }) => {
      actions.push(action);
      return { decision: "allow" };
    };
    await executeOperation({
      projectDir,
      actor: "bob",
      operation: "task.take",
      input: { id: "T1", at: "2026-09-26T01:00:00.000Z" },
      source,
    });
    assert.deepEqual(actions, ["task.take"]);
    const after = await readState(projectDir);
    assert.equal(after.log.at(-1)!.action, "task.take");
  } finally {
    await rmTempProject(projectDir);
  }
});

test("opt-in takeover without an applicable policy retains ALREADY_CLAIMED", async () => {
  const state = await fixture();
  try {
    const before = await readState(state.projectDir);
    await assert.rejects(
      attemptTakeover({ ...state }),
      (error) => errorLike(error).code === "ALREADY_CLAIMED" && errorLike(error).details?.owner === "alice",
    );
    const after = await readState(state.projectDir);
    assert.deepEqual(after.nodes.T1, before.nodes.T1);
    assert.deepEqual(after.log, before.log);
  } finally {
    await rmTempProject(state.projectDir);
  }
});

test("opt-in takeover requires explicit allow and records the plan audit action", async () => {
  const state = await fixture();
  try {
    const actions: string[] = [];
    const mutation = await attemptTakeover({
      ...state,
      policy: { pluginId: "policy-fixture" },
      authorizeAction: async ({ action }) => {
        actions.push(action);
        return { decision: "allow" };
      },
    });
    assert.deepEqual(actions, ["task.takeover"]);
    assert.equal(mutation.result.freshly_claimed, true);
    const after = await readState(state.projectDir);
    assert.equal(after.nodes.T1.claim.by, "bob");
    assert.equal(after.log.at(-1)!.action, "take");
    assert.equal(after.log.at(-1)!.previous_owner, "alice");
    assert.equal(after.log.at(-1)!.agent, "bob");
  } finally {
    await rmTempProject(state.projectDir);
  }
});

test("opt-in takeover deny remains POLICY_DENIED and default operation policy action stays unchanged", async () => {
  const denied = await fixture();
  try {
    const before = await readState(denied.projectDir);
    await assert.rejects(
      attemptTakeover({
        ...denied,
        policy: { pluginId: "policy-fixture" },
        authorizeAction: async () => ({ decision: "deny", reason: "no takeover" }),
      }),
      (error) => errorLike(error).code === "POLICY_DENIED" && errorLike(error).details?.action === "task.takeover"
    );
    const after = await readState(denied.projectDir);
    assert.deepEqual(after.nodes.T1, before.nodes.T1);
    assert.deepEqual(after.log, before.log);
  } finally {
    await rmTempProject(denied.projectDir);
  }

  const defaultCall = await fixture();
  try {
    const actions: string[] = [];
    const mutation = await attemptTakeover({
      ...defaultCall,
      policy: { pluginId: "policy-fixture" },
      authorizeAction: async ({ action }) => {
        actions.push(action);
        return { decision: "allow" };
      },
      optIn: false,
    });
    assert.deepEqual(actions, ["task.take"]);
    assert.equal(mutation.result.freshly_claimed, true);
  } finally {
    await rmTempProject(defaultCall.projectDir);
  }
});
