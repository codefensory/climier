import test from "node:test";
import assert from "node:assert/strict";

import addTask from "../src/cli/commands/add-task.mjs";
import update from "../src/cli/commands/update.mjs";
import take from "../src/cli/commands/take.mjs";
import release from "../src/cli/commands/release.mjs";
import reopen from "../src/cli/commands/reopen.mjs";
import cancel from "../src/cli/commands/cancel.mjs";
import submit from "../src/cli/commands/submit.mjs";
import accept from "../src/cli/commands/accept.mjs";
import reject from "../src/cli/commands/reject.mjs";
import { createTempProject, readState, rmTempProject, writeState } from "./helpers.mjs";

const sentinelState = {
  version: 4,
  revision: 11,
  initiatives: { local: { desc: "local sentinel" }, remote: { desc: "remote initiative" } },
  nodes: {
    "T-local": {
      id: "T-local",
      kind: "resolvable",
      subkind: "task",
      title: "local sentinel",
      status: "open",
      revision: 2,
    },
    "T-remote": taskNode("T-remote", { status: "done" }),
  },
  edges: [],
  plugins: {},
  log: [{ id: "local-sentinel" }],
};

function taskNode(id, extra = {}) {
  return {
    id,
    kind: "resolvable",
    subkind: "task",
    title: id,
    status: "open",
    revision: 12,
    ...extra,
  };
}

const lifecycle = [
  {
    name: "create",
    operation: "task.create",
    run: (args) => addTask({
      ...args,
      positional: ["T-created"],
      flags: { initiative: "remote", title: "new task", body: "body", acceptance: "acceptance", "blocked-by": "", as: "alice" },
    }),
    input: {
      id: "T-created", initiative: "remote", title: "new task", body: "body", acceptance: "acceptance",
      blocked_by: [], backlog: false, tags: [], refs: [], definition: undefined, domain: undefined,
      derived_from: [], meta: undefined,
    },
    node: taskNode("T-created"),
    envelope: (node) => ({ node }),
  },
  {
    name: "update",
    operation: "task.update",
    run: (args) => update({ ...args, positional: ["T-remote"], flags: { title: "updated", as: "alice" } }),
    input: { id: "T-remote", changes: { title: "updated" }, if_revision: 12 },
    node: taskNode("T-remote", { title: "updated" }),
    envelope: (node) => ({ node }),
  },
  {
    name: "take",
    operation: "task.take",
    run: (args) => take({ ...args, positional: ["T-remote"], flags: { as: "alice" } }),
    input: { id: "T-remote" },
    node: taskNode("T-remote", { status: "in_progress", claim: { by: "alice", at: "2026-09-25T00:00:00.000Z" } }),
    result: { freshly_claimed: true },
    envelope: (node, result) => ({
      node,
      context: { derived_status: node.status, revision: node.revision, claim: node.claim || null, blocking: [], knowledge: [] },
      freshly_claimed: result.freshly_claimed,
    }),
  },
  {
    name: "release",
    operation: "task.release",
    run: (args) => release({ ...args, positional: ["T-remote"], flags: { as: "alice" } }),
    input: { id: "T-remote" },
    node: taskNode("T-remote"),
    result: { released: true },
    envelope: (node, result) => ({ released: result.released, node }),
  },
  {
    name: "reopen",
    operation: "task.reopen",
    run: (args) => reopen({ ...args, positional: ["T-remote"], flags: { reason: "retry", as: "alice" } }),
    input: { id: "T-remote", reason: "retry" },
    node: taskNode("T-remote"),
    envelope: (node) => ({ node }),
  },
  {
    name: "cancel",
    operation: "task.cancel",
    run: (args) => cancel({ ...args, positional: ["T-remote"], flags: { reason: "stop", as: "alice" } }),
    input: { id: "T-remote", reason: "stop" },
    node: taskNode("T-remote"),
    envelope: (node) => ({ node }),
  },
  {
    name: "submit",
    operation: "task.submit",
    run: (args) => submit({ ...args, positional: ["T-remote"], flags: { note: "ready", as: "alice" } }),
    input: { id: "T-remote", note: "ready", actor: "alice" },
    node: taskNode("T-remote", { status: "submitted" }),
    envelope: (node) => ({ node, newly_ready: [] }),
  },
  {
    name: "accept",
    operation: "task.accept",
    run: (args) => accept({ ...args, positional: ["T-remote"], flags: { as: "alice" } }),
    input: { id: "T-remote", actor: "alice" },
    node: taskNode("T-remote", { status: "done" }),
    envelope: (node) => ({ node, newly_ready: [] }),
  },
  {
    name: "reject",
    operation: "task.reject",
    run: (args) => reject({ ...args, positional: ["T-remote"], flags: { reason: "revise", as: "alice" } }),
    input: { id: "T-remote", reason: "revise" },
    node: taskNode("T-remote"),
    envelope: (node) => ({ node }),
  },
];

function createClient(operationCase, { error } = {}) {
  const calls = [];
  const inputNode = operationCase.name === "create" ? taskNode("T-remote") : taskNode("T-remote", {
    status: ({
      "task.take": "open",
      "task.release": "in_progress",
      "task.reopen": "done",
      "task.cancel": "open",
      "task.submit": "in_progress",
      "task.accept": "submitted",
      "task.reject": "submitted",
      "task.update": "open",
    })[operationCase.operation] || "open",
    claim: ["task.release", "task.submit"].includes(operationCase.operation) ? { by: "alice" } : undefined,
  });
  return {
    calls,
    client: {
      type: "remote",
      async readNode({ id }) {
        calls.push({ method: "readNode", options: { id } });
        return { type: "task", node: { ...inputNode, id } };
      },
      async executeOperation(args) {
        calls.push(args);
        if (error) throw error;
        const result = { diff: { created: [], updated: [] }, result: operationCase.result || {}, effects: null };
        const entry = { id: operationCase.node.id, node: operationCase.node };
        if (operationCase.operation === "task.create") result.diff.created.push(entry);
        else result.diff.updated.push(entry);
        return result;
      },
      async executeBatch() { throw new Error("unexpected batch"); },
    },
  };
}

for (const operationCase of lifecycle) {
  test(`remote task ${operationCase.name} routes through bridge and preserves CLI envelope`, async () => {
    const projectDir = await createTempProject();
    try {
      await writeState(projectDir, sentinelState);
      const before = await readState(projectDir);
      const { client, calls } = createClient(operationCase);
      const result = await operationCase.run({ projectDir, statePath: projectDir, backendClient: client });
      assert.deepEqual(result, operationCase.envelope(operationCase.node, operationCase.result || {}));
      const call = calls.find((entry) => entry.operation === operationCase.operation);
      assert.equal(call.actor, "alice");
      const expectedInput = { ...operationCase.input };
      delete expectedInput.actor;
      assert.deepEqual(call.input, expectedInput);
      assert.equal(Object.hasOwn(call.input, "actor"), false);
      if (! ["create", "take", "release"].includes(operationCase.name)) {
        assert.deepEqual(calls[0], { method: "readNode", options: { id: "T-remote" } });
      }
      assert.deepEqual(await readState(projectDir), before);
    } finally {
      await rmTempProject(projectDir);
    }
  });
}

test("remote task failures propagate without fallback or changing local sentinel", async () => {
  const errors = [
    Object.assign(new Error("unauthorized"), { code: "AUTH_REQUIRED", status: 401 }),
    Object.assign(new Error("wrong protocol"), { code: "PROTOCOL_VERSION_UNSUPPORTED" }),
    Object.assign(new Error("endpoint unavailable"), { code: "REMOTE_REQUEST_FAILED" }),
  ];
  const projectDir = await createTempProject();
  try {
    await writeState(projectDir, sentinelState);
    const before = await readState(projectDir);
    for (const error of errors) {
      for (const operationCase of lifecycle) {
        const { client, calls } = createClient(operationCase, { error });
        await assert.rejects(
          operationCase.run({ projectDir, statePath: projectDir, backendClient: client }),
          (actual) => actual === error,
          `${operationCase.name} must propagate ${error.code}`,
        );
        if (["update", "reopen", "cancel", "submit", "accept", "reject"].includes(operationCase.name)) {
          assert.equal(calls.filter((call) => call.operation === operationCase.operation).length, 1);
        } else if (!["create", "take", "release"].includes(operationCase.name)) {
          assert.deepEqual(calls, [{ method: "readNode", options: { id: "T-remote" } }]);
        } else {
          assert.equal(calls.filter((call) => call.operation === operationCase.operation).length, 1);
        }
      }
      assert.deepEqual(await readState(projectDir), before);
    }
  } finally {
    await rmTempProject(projectDir);
  }
});
