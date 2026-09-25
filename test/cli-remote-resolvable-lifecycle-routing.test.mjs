import test from "node:test";
import assert from "node:assert/strict";

import reopen from "../src/cli/commands/reopen.mjs";
import cancel from "../src/cli/commands/cancel.mjs";
import { createTempProject, readState, rmTempProject, writeState } from "./helpers.mjs";

const initialState = {
  version: 4,
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

function remoteClient(node, { failure, readFailure } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      type: "remote",
      async readNode({ id }) {
        calls.push({ method: "readNode", id });
        if (readFailure) throw readFailure;
        return { node: node ? { ...node, id } : null };
      },
      async executeOperation(args) {
        calls.push(args);
        if (failure) throw failure;
        const updated = { ...node, status: args.operation.endsWith("reopen") ? "open" : "canceled", revision: 8 };
        return { diff: { created: [], updated: [{ id: node.id, node: updated }] }, result: {}, effects: null };
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
        await writeState(projectDir, initialState);
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
    await writeState(projectDir, initialState);
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
    await writeState(projectDir, {
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

test("remote lifecycle errors propagate without fallback or local mutation", async () => {
  const errors = [
    Object.assign(new Error("unauthorized"), { code: "AUTH_REQUIRED", status: 401 }),
    Object.assign(new Error("wrong protocol"), { code: "PROTOCOL_VERSION_UNSUPPORTED" }),
    Object.assign(new Error("offline"), { code: "REMOTE_REQUEST_FAILED" }),
  ];
  const projectDir = await createTempProject();
  try {
    await writeState(projectDir, initialState);
    const before = await readState(projectDir);
    for (const error of errors) {
      for (const command of commands) {
        for (const subkind of ["task", "gate"]) {
          const target = node(`R-${subkind}`, subkind);
          const { client: executeClient, calls: executeCalls } = remoteClient(target, { failure: error });
          await assert.rejects(
            command.run({ projectDir, statePath: projectDir, backendClient: executeClient, positional: [target.id], flags: { as: "alice" } }),
            (actual) => actual === error,
          );
          assert.equal(executeCalls.filter((call) => call.operation === command.operation(subkind)).length, 1);

          const { client: readClient, calls: readCalls } = remoteClient(target, { readFailure: error });
          await assert.rejects(
            command.run({ projectDir, statePath: projectDir, backendClient: readClient, positional: [target.id], flags: { as: "alice" } }),
            (actual) => actual === error,
          );
          assert.deepEqual(readCalls, [{ method: "readNode", id: target.id }]);
          assert.deepEqual(await readState(projectDir), before);
        }
      }
    }
  } finally {
    await rmTempProject(projectDir);
  }
});
