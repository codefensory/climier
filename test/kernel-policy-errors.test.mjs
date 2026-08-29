// test/kernel-policy-errors.test.mjs — T-graph-kernel-policy-errors-fix.
//
// Scope (per task body): src/kernel/mutate.mjs + this new test file.
// The acceptance the kernel now enforces in runPolicy:
//   - decide() throwing a POLICY_* error (PolicyError from
//     authorizeAction, or any error carrying a `POLICY_*` code) must
//     propagate with the original code and details, NOT be rewritten
//     as INVALID_EXECUTION_CONTRACT.
//   - decide() returning `{ decision: "deny", reason }` must surface
//     as POLICY_DENIED with details carrying `plugin_id`, `action`,
//     `actor`, and `reason`. No mutation. No log entry.
//   - decide() returning a malformed response (non-object, unknown
//     `decision` value) is still a contract violation and surfaces
//     as INVALID_EXECUTION_CONTRACT — the malformed-shape path has
//     not been relaxed.
//   - decide() throwing a non-POLICY error (a plain Error / TypeError
//     / generic exception) is still a real callback contract failure
//     and surfaces as INVALID_EXECUTION_CONTRACT.
//   - decide() returning `allow` or `abstain` proceeds (regression
//     cover).
//
// The AsyncLocalStorage nested-guard regression from
// T-graph-kernel-mutate-concurrency-fix is preserved by exercising
// the same-chain nested path here too (cheap, focused, no need to
// read the dedicated suite).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState as writeStateHelper,
  readState as readStateHelper,
} from "./helpers.mjs";

async function importKernel() {
  return importFresh("./kernel/mutate.mjs");
}

// ===================================================================
// Fixture
// ===================================================================

async function bootstrap(dir) {
  await writeStateHelper(dir, {
    version: 2,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "T1-title",
        initiative: "kernel",
        status: "open",
        revision: 3,
      },
    },
    edges: [],
    initiatives: { kernel: { desc: "kernel", created_at: "2026-01-01T00:00:00.000Z" } },
    log: [],
  });
  return readStateHelper(dir);
}

// updateProvider — minimal provider that mutates T1. The kernel's
// runPolicy sits between prepare and apply; the same provider is
// reused across all tests below so the only variable under test is
// the policyAction shape / behaviour.
const updateProvider = {
  prepare: async ({ snapshot }) => ({
    target: {
      id: "T1",
      kind: snapshot.nodes.T1.kind,
      subkind: snapshot.nodes.T1.subkind,
      revision: snapshot.nodes.T1.revision,
    },
    policyAction: null,
    newTitle: "mutated",
  }),
  apply: async ({ tx, plan }) => {
    tx.updateNode("T1", { title: plan.newTitle });
    return { result: { id: "T1", title: plan.newTitle }, effects: null };
  },
};

function baseRequest() {
  return {
    action: "task.update",
    actor: "alice",
    input: {},
    if_revision: { kind: "single", id: "T1", value: 3 },
  };
}

// ===================================================================
// 1) deny decision → POLICY_DENIED with the required details
// ===================================================================

test("kernel.mutate: deny decision produces POLICY_DENIED with plugin_id, action, actor, reason; no mutation, no log", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrap(dir);
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => ({ decision: "deny", reason: "no updates today" }),
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "deny must throw");
    assert.equal(caught.code, "POLICY_DENIED", "deny surfaces as POLICY_DENIED");
    assert.equal(caught.details.plugin_id, "policy-fixture", "details.plugin_id is the policy plugin id");
    assert.equal(caught.details.action, "task.update", "details.action is the policy action");
    assert.equal(caught.details.actor, "alice", "details.actor is the request actor");
    assert.equal(caught.details.reason, "no updates today", "details.reason is the deny reason");
    // Message mentions the actor so logs are grep-able.
    assert.match(caught.message, /task\.update/);
    assert.match(caught.message, /alice/);
    assert.match(caught.message, /no updates today/);

    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes.T1, base.nodes.T1, "no state mutation after deny");
    assert.equal(after.log.length, 0, "no log entry on deny");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 2) deny without reason field → POLICY_DENIED with reason=null
// ===================================================================

test("kernel.mutate: deny decision without a reason field produces POLICY_DENIED with reason=null", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => ({ decision: "deny" }),
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "POLICY_DENIED");
    assert.equal(caught.details.actor, "alice");
    assert.equal(caught.details.reason, null, "missing reason becomes null (not undefined, not '(no reason)')");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 3) decide() throwing POLICY_ERROR → propagated as POLICY_ERROR
//    (this is the regression: used to be converted to INVALID_EXECUTION_CONTRACT)
// ===================================================================

test("kernel.mutate: decide() throwing POLICY_ERROR propagates code and details (no conversion to INVALID_EXECUTION_CONTRACT)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrap(dir);
    // Shape mirrors src/plugin-errors.mjs PolicyError so the test is a
    // faithful surrogate for what authorizeAction would throw. The
    // kernel must not need to import src/plugin-errors.mjs to honour
    // this contract — code-prefix matching is enough.
    const policyErr = new Error(
      "policy: plugin 'policy-fixture' raised an error during action 'task.update': authorize returned unknown decision: \"maybe\"",
    );
    policyErr.code = "POLICY_ERROR";
    policyErr.details = {
      plugin_id: "policy-fixture",
      op: "task.update",
      action: "task.update",
      cause_code: null,
      cause_message: 'authorize returned unknown decision: "maybe"',
    };
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => {
        throw policyErr;
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "policy error must propagate");
    assert.equal(caught.code, "POLICY_ERROR", "POLICY_ERROR code is preserved");
    assert.equal(caught.details.plugin_id, "policy-fixture");
    assert.equal(caught.details.action, "task.update");
    assert.equal(caught.details.cause_message, 'authorize returned unknown decision: "maybe"',
      "cause_message preserved verbatim");

    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes.T1, base.nodes.T1, "no mutation after POLICY_ERROR");
    assert.equal(after.log.length, 0, "no log entry on POLICY_ERROR");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 4) decide() throwing POLICY_CONFLICT → propagated (other POLICY_* codes too)
// ===================================================================

test("kernel.mutate: decide() throwing POLICY_CONFLICT propagates the code and details", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const policyErr = new Error("policy: 2 applicable policies conflict");
    policyErr.code = "POLICY_CONFLICT";
    policyErr.details = {
      plugin_ids: ["a", "b"],
      namespaces: ["a", "b"],
      cause_message: null,
    };
    const policyAction = {
      pluginId: "policy-a",
      action: "task.update",
      decide: async () => {
        throw policyErr;
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "POLICY_CONFLICT");
    assert.deepEqual(caught.details.plugin_ids, ["a", "b"]);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 5) decide() throwing POLICY_DENIED directly is also honoured
//    (not just the return-shape path)
// ===================================================================

test("kernel.mutate: decide() throwing POLICY_DENIED is propagated with the original envelope (no mutation)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    const base = await bootstrap(dir);
    const policyErr = new Error(
      "policy: plugin 'policy-fixture' denied action 'task.update' for actor 'alice': not allowed",
    );
    policyErr.code = "POLICY_DENIED";
    policyErr.details = {
      plugin_id: "policy-fixture",
      op: "task.update",
      action: "task.update",
      reason: "not allowed",
      actor: "alice",
    };
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => {
        throw policyErr;
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "POLICY_DENIED");
    assert.equal(caught.details.reason, "not allowed");
    const after = await readStateHelper(dir);
    assert.deepEqual(after.nodes.T1, base.nodes.T1, "no mutation");
    assert.equal(after.log.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 6) decide() throwing a NON-policy error → INVALID_EXECUTION_CONTRACT
//    (a real callback contract failure, not a policy-domain error)
// ===================================================================

test("kernel.mutate: decide() throwing a plain Error (no POLICY_* code) is still INVALID_EXECUTION_CONTRACT", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => {
        throw new Error("callback crashed unexpectedly");
      },
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT", "non-policy throw → contract violation");
    assert.match(caught.message, /callback crashed unexpectedly/);
    assert.equal(caught.details.action, "task.update", "details still carry the action under test");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 7) Malformed response: decide() returning a non-object → INVALID_EXECUTION_CONTRACT
// ===================================================================

test("kernel.mutate: decide() returning a non-object response stays INVALID_EXECUTION_CONTRACT", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => "allow", // wrong shape: string instead of object
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
    assert.equal(caught.details.field, "policyAction");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 8) Malformed response: decide() returning an object with an unknown
//    decision value → INVALID_EXECUTION_CONTRACT
// ===================================================================

test("kernel.mutate: decide() returning an object with an unknown decision stays INVALID_EXECUTION_CONTRACT", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => ({ decision: "maybe" }), // not allow|deny|abstain
    };
    let caught;
    try {
      await mutate({
        projectDir: dir,
        request: baseRequest(),
        provider: updateProvider,
        policyAction,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "INVALID_EXECUTION_CONTRACT");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 9) allow decision → mutation proceeds (regression cover)
// ===================================================================

test("kernel.mutate: decide() returning allow proceeds with the mutation", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => ({ decision: "allow" }),
    };
    const out = await mutate({
      projectDir: dir,
      request: baseRequest(),
      provider: updateProvider,
      policyAction,
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.title, "mutated");
    assert.equal(after.nodes.T1.revision, 4, "revision bumped once after allow");
    assert.equal(after.log.length, 1, "log entry written after allow");
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 10) abstain decision → mutation proceeds (regression cover)
// ===================================================================

test("kernel.mutate: decide() returning abstain proceeds with the mutation", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const policyAction = {
      pluginId: "policy-fixture",
      action: "task.update",
      decide: async () => ({ decision: "abstain" }),
    };
    const out = await mutate({
      projectDir: dir,
      request: baseRequest(),
      provider: updateProvider,
      policyAction,
    });
    assert.equal(out.idempotent, false);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.title, "mutated");
    assert.equal(after.log.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

// ===================================================================
// 11) AsyncLocalStorage nested guard is preserved (cheap focused cover)
// ===================================================================

test("kernel.mutate: same-chain nested mutate still rejected with INVALID_EXECUTION_CONTRACT (AsyncLocalStorage guard preserved)", async () => {
  const { mutate } = await importKernel();
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    let innerCaught = null;
    await mutate({
      projectDir: dir,
      request: baseRequest(),
      provider: {
        prepare: async ({ snapshot }) => ({
          target: {
            id: "T1",
            kind: snapshot.nodes.T1.kind,
            subkind: snapshot.nodes.T1.subkind,
            revision: snapshot.nodes.T1.revision,
          },
          policyAction: null,
        }),
        apply: async () => {
          try {
            await mutate({
              projectDir: dir,
              request: baseRequest(),
              provider: updateProvider,
            });
            throw new Error("inner mutate should have thrown");
          } catch (err) {
            innerCaught = err;
          }
          return { result: null };
        },
      },
    });
    assert.ok(innerCaught, "inner mutate must reject");
    assert.equal(innerCaught.code, "INVALID_EXECUTION_CONTRACT");
    assert.match(innerCaught.message, /nested kernel\.mutate/i);
    const after = await readStateHelper(dir);
    assert.equal(after.nodes.T1.title, "T1-title", "T1 untouched — nested call rejected before any tx");
    assert.equal(after.log.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});
