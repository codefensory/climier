import test from "node:test";
import assert from "node:assert/strict";

import reopen from "../src/cli/commands/reopen.ts";
import cancel from "../src/cli/commands/cancel.ts";
import release from "../src/cli/commands/release.ts";
import submit from "../src/cli/commands/submit.ts";
import accept from "../src/cli/commands/accept.ts";
import reject from "../src/cli/commands/reject.ts";
import { createTempProject, readState, rmTempProject, writeCanonicalState, runCli, initExampleProject, installPolicyFixture, uninstallPolicyFixture } from "./helpers.mjs";

const initialState = {
  version: 1,
  revision: 7,
  initiatives: { local: { desc: "sentinel" } },
  nodes: {
    "T-local": { id: "T-local", kind: "resolvable", subkind: "task", title: "local sentinel", status: "open", revision: 2 },
  },
  edges: [],
  plugins: {},
  log: [{ id: "local-sentinel" }],
};

const commands = [
  { name: "reopen", run: reopen, operation: (subkind) => `${subkind}.reopen`, reason: "retry" },
  { name: "cancel", run: cancel, operation: (subkind) => `${subkind}.cancel`, reason: "stop" },
];

const taskLifecycleCommands = [
  { name: "release", run: release, operation: "task.release", status: "open", input: (id) => ({ id }), flags: {} },
  { name: "submit", run: submit, operation: "task.submit", status: "submitted", input: (id) => ({ id, note: "review" }), flags: { note: "review" } },
  { name: "accept", run: accept, operation: "task.accept", status: "done", input: (id) => ({ id }), flags: {} },
  { name: "reject", run: reject, operation: "task.reject", status: "open", input: (id) => ({ id, reason: "retry" }), flags: { reason: "retry" } },
];

function lifecycleRemoteClient(target, { failure } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      type: "remote",
      async readNode({ id }) {
        calls.push({ method: "readNode", id });
        return { node: target ? { ...target, id } : null };
      },
      async executeOperation(args) {
        calls.push(args);
        if (failure) { throw failure; }
        const updated = { ...target, status: taskLifecycleCommands.find((command) => command.operation === args.operation).status, revision: 8 };
        return { result: { released: args.operation === "task.release" }, diff: { created: [], updated: [{ id: target.id, node: updated }] }, effects: { newly_ready: ["T-next"] } };
      },
      async executeBatch() { throw new Error("unexpected batch"); },
    },
  };
}

function mutationFor(id, status, operation) {
  return {
    result: { released: operation === "task.release" },
    diff: { created: [], updated: [{ id, node: { id, kind: "resolvable", subkind: "task", status, revision: 8, claim: null } }] },
    effects: { newly_ready: ["T-next"] },
  };
}

for (const command of taskLifecycleCommands) {
  test(`remote ${command.name} routes through its canonical task operation`, async () => {
    const projectDir = await createTempProject();
    try {
      await writeCanonicalState(projectDir, initialState);
      const before = await readState(projectDir);
      const target = node("R-task", "task", { status: command.name === "release" ? "in_progress" : "submitted", claim: { by: "alice" } });
      const { client, calls } = lifecycleRemoteClient(target);
      const result = await command.run({ projectDir, statePath: projectDir, backendClient: client, positional: [target.id], flags: { ...command.flags, as: "alice" } });
      assert.equal(calls.find((call) => call.operation)?.operation, command.operation);
      assert.deepEqual(calls.find((call) => call.operation)?.input, command.input(target.id));
      assert.equal(calls.find((call) => call.operation)?.actor, "alice");
      assert.equal(result.node.status, command.status);
      if (command.name === "release") { assert.equal(result.released, true); }
      if (command.name === "submit" || command.name === "accept") { assert.deepEqual(result.newly_ready, ["T-next"]); }
      assert.deepEqual(await readState(projectDir), before, "remote success must not mutate local state");
    } finally {
      await rmTempProject(projectDir);
    }
  });

  test(`local ${command.name} delegates once through the operation bridge`, async () => {
    const id = "T-local-bridge";
    const calls = [];
    const backendClient = {
      type: "local",
      async executeOperation(args) {
        calls.push(args);
        return mutationFor(id, command.status, command.operation);
      },
      async executeBatch() { throw new Error("unexpected batch"); },
    };
    const projectDir = await createTempProject();
    try {
      const startingStatus = command.name === "release" || command.name === "submit" ? "in_progress" : "submitted";
      await writeCanonicalState(projectDir, {
        ...initialState,
        nodes: {
          ...initialState.nodes,
          [id]: { id, kind: "resolvable", subkind: "task", title: id, status: startingStatus, claim: startingStatus === "in_progress" ? { by: "alice" } : null, note: "review" },
        },
      });
      const result = await command.run({
      projectDir,
      statePath: projectDir,
      backendClient,
      positional: [id],
      flags: { ...command.flags, as: "alice" },
      });
      assert.deepEqual(calls, [{ actor: "alice", operation: command.operation, input: { ...command.input(id), ...(command.name === "release" || command.name === "submit" || command.name === "accept" ? { actor: "alice" } : {}) } }]);
      assert.equal(result.node.status, command.status);
    } finally {
      await rmTempProject(projectDir);
    }
  });
}

function remoteClient(targetNode, { failure, readFailure } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      type: "remote",
      async readNode({ id }) {
        calls.push({ method: "readNode", id });
        if (readFailure) { throw readFailure; }
        return { node: targetNode ? { ...targetNode, id } : null };
      },
      async executeOperation(args) {
        calls.push(args);
        if (failure) { throw failure; }
        const updated = { ...targetNode, status: args.operation.endsWith("reopen") ? "open" : "canceled", revision: 8 };
        return { diff: { created: [], updated: [{ id: targetNode.id, node: updated }] }, result: {}, effects: null };
      },
      async executeBatch() { throw new Error("unexpected batch"); },
    },
  };
}

function node(id, subkind, extra = {}) {
  return { id, kind: "resolvable", subkind, title: id, status: "done", revision: 7, ...extra };
}

for (const command of commands) {
  for (const subkind of ["task", "gate"]) {
    test(`remote ${command.name} routes ${subkind} through its canonical operation`, async () => {
      const projectDir = await createTempProject();
      try {
        await writeCanonicalState(projectDir, initialState);
        const before = await readState(projectDir);
        const target = node(`R-${subkind}`, subkind);
        const { client, calls } = remoteClient(target);
        const result = await command.run({
          projectDir,
          statePath: projectDir,
          backendClient: client,
          positional: [target.id],
          flags: { reason: command.reason, as: "alice" },
        });
        assert.deepEqual(result, { node: { ...target, status: command.name === "reopen" ? "open" : "canceled", revision: 8 } });
        assert.deepEqual(calls[0], { method: "readNode", id: target.id });
        assert.equal(calls.filter((call) => call.method === "readNode").length, 1);
        assert.equal(calls[1].operation, command.operation(subkind));
        assert.equal(calls[1].actor, "alice");
        assert.deepEqual(calls[1].input, { id: target.id, reason: command.reason });
        assert.deepEqual(await readState(projectDir), before, "remote success must not mutate local state");
      } finally {
        await rmTempProject(projectDir);
      }
    });
  }
}

test("remote lifecycle rejects unsupported target kinds before mutation", async () => {
  const projectDir = await createTempProject();
  try {
    await writeCanonicalState(projectDir, initialState);
    const before = await readState(projectDir);
    for (const target of [
      { id: "K-remote", kind: "knowledge", subkind: undefined },
      { id: "R-remote", kind: "resolvable", subkind: "knowledge" },
      { id: "X-remote", kind: "other", subkind: "task" },
      null,
    ]) {
      for (const command of commands) {
        const { client, calls } = remoteClient(target);
        await assert.rejects(
          command.run({ projectDir, statePath: projectDir, backendClient: client, positional: ["R-remote"], flags: { as: "alice" } }),
          (error) => error.code === "REMOTE_UNSUPPORTED_OPERATION",
        );
        assert.equal(calls.filter((call) => call.operation).length, 0);
        assert.deepEqual(await readState(projectDir), before);
      }
    }
  } finally {
    await rmTempProject(projectDir);
  }
});

test("local lifecycle commands retain their existing mutation semantics and envelopes", async () => {
  const projectDir = await createTempProject();
  try {
    await writeCanonicalState(projectDir, {
      ...initialState,
      nodes: {
        "T-local": { id: "T-local", kind: "resolvable", subkind: "task", title: "local task", status: "done", revision: 2, done_by: "alice", done_at: "2026-09-25T00:00:00.000Z" },
        "G-local": { id: "G-local", kind: "resolvable", subkind: "gate", title: "local gate", status: "resolved", revision: 2, resolution: { choice: "yes" } },
      },
    });
    for (const [command, id, expectedStatus] of [
      [reopen, "T-local", "open"],
      [reopen, "G-local", "open"],
      [cancel, "T-local", "canceled"],
      [cancel, "G-local", "canceled"],
    ]) {
      const result = await command({ projectDir, statePath: projectDir, positional: [id], flags: { reason: "local check", as: "alice" } });
      assert.ok(result.node, "local command keeps the { node } envelope");
      assert.equal(result.node.id, id);
      assert.equal(result.node.status, expectedStatus);
      assert.equal((await readState(projectDir)).nodes[id].status, expectedStatus);
    }
  } finally {
    await rmTempProject(projectDir);
  }
});

async function assertLifecycleError(projectDir, before, { error, command, subkind }) {
  const target = node(`R-${subkind}`, subkind);
  const { client: executeClient, calls: executeCalls } = remoteClient(target, { failure: error });
  await assert.rejects(command.run({ projectDir, statePath: projectDir, backendClient: executeClient, positional: [target.id], flags: { as: "alice" } }), (actual) => actual === error);
  assert.equal(executeCalls.filter((call) => call.operation === command.operation(subkind)).length, 1);
  const { client: readClient, calls: readCalls } = remoteClient(target, { readFailure: error });
  await assert.rejects(command.run({ projectDir, statePath: projectDir, backendClient: readClient, positional: [target.id], flags: { as: "alice" } }), (actual) => actual === error);
  assert.deepEqual(readCalls, [{ method: "readNode", id: target.id }]);
  assert.deepEqual(await readState(projectDir), before);
}

async function assertLifecycleFailures(projectDir, before, error, command) {
  for (const subkind of ["task", "gate"]) {
    await assertLifecycleError(projectDir, before, { error, command, subkind });
  }
}

test("remote lifecycle errors propagate without fallback or local mutation", async () => {
  const errors = [
    Object.assign(new Error("unauthorized"), { code: "AUTH_REQUIRED", status: 401 }),
    Object.assign(new Error("wrong protocol"), { code: "PROTOCOL_VERSION_UNSUPPORTED" }),
    Object.assign(new Error("offline"), { code: "REMOTE_REQUEST_FAILED" }),
  ];
  const projectDir = await createTempProject();
  try {
    await writeCanonicalState(projectDir, initialState);
    const before = await readState(projectDir);
    for (const error of errors) {
      for (const command of commands) {
        await assertLifecycleFailures(projectDir, before, error, command);
      }
    }
  } finally {
    await rmTempProject(projectDir);
  }
});

test("CLI: reopen --as policy-allow actor rolls back a done task end-to-end", async () => {

  // policy-fixture: under ADR-009 the core itself accepts any actor,
  // so this case pins the policy allow behavior explicitly. Without
  // the fixture the same reopen would also succeed (default core).
  const dir = await createTempProject();
  await installPolicyFixture(dir);
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "take", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "submit", "F0.T1", "--note", "shipped", "--as", "agent-1"]);
    await runCli(["--project", dir, "accept", "F0.T1", "--as", "validator"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "--reason", "le falta validacion", "--as", "auditor",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id, "F0.T1");
    assert.equal(data.node.status, "open");

    // F0.T2 (depends on F0.T1) should be blocked again, not ready.
    const s = await runCli(["--project", dir, "status"]);
    assert.equal(s.code, 0, s.stderr);
    const sdata = JSON.parse(s.stdout);
    const blockedIds = (sdata.tasks.blocked || []).map((t) => t.id);
    assert.equal(blockedIds.includes("F0.T2"), true, "F0.T2 should be blocked after reopen");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

function assertReopenedTask(data) {
  assert.equal(data.node.id, "F0.T1");
  assert.equal(data.node.status, "open");
  assert.equal(data.node.done_by, undefined, "done_by cleared on reopen");
  assert.equal(data.node.done_at, undefined, "done_at cleared on reopen");
  assert.equal(data.node.note, undefined, "note cleared on reopen");
  assert.equal(data.node.claim, null, "claim cleared on reopen");
}

test("CLI: reopen by a stranger succeeds under ADR-009 (no ownership compare on done_by)", async () => {

  // resolvable from any actor; the core only checks state validity and
  // required fields. State validation and required-field enforcement
  // are still verified separately (see the next two tests).
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "take", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "submit", "F0.T1", "--note", "shipped", "--as", "agent-1"]);
    await runCli(["--project", dir, "accept", "F0.T1", "--as", "validator"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "--reason", "I want to", "--as", "agent-2",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assertReopenedTask(data);

    // F0.T2 (depends on F0.T1) must be blocked again.
    const s = await runCli(["--project", dir, "status"]);
    assert.equal(s.code, 0, s.stderr);
    const sdata = JSON.parse(s.stdout);
    const blockedIds = (sdata.tasks.blocked || []).map((t) => t.id);
    assert.equal(blockedIds.includes("F0.T2"), true, "F0.T2 should be blocked after reopen");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: reopen without --reason still fails with MISSING_FIELD (required field is enforced)", async () => {

  // are part of the core contract; only ownership checks were removed.
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "take", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "submit", "F0.T1", "--note", "shipped", "--as", "agent-1"]);
    await runCli(["--project", dir, "accept", "F0.T1", "--as", "validator"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "--as", "agent-2",
    ]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error.message || data.error, /--reason/);
  } finally {
    await rmTempProject(dir);
  }
});
