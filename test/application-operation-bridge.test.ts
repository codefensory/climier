import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOperationBridge,
  SUPPORTED_OPERATION_IDS,
} from "../src/application/operations/index.ts";
import { remoteV1Manifest } from "../src/application/operations/remote-v1-manifest.ts";
import type { BackendClient, OperationCall } from "../src/application/types.ts";

type Handler = (args: OperationCall) => unknown;

type Handlers = {
  executeOperation?: Handler;
  executeBatch?: Handler;
};

function backendClient(type: "local" | "remote", calls: Array<{ method: string; args: OperationCall }>, handlers: Handlers = {}): BackendClient {
  return {
    type,
    async executeOperation(args: OperationCall = {}) {
      calls.push({ method: "executeOperation", args });
      return handlers.executeOperation ? handlers.executeOperation(args) : { backend: type };
    },
    async executeBatch(args: OperationCall = {}) {
      calls.push({ method: "executeBatch", args });
      return handlers.executeBatch ? handlers.executeBatch(args) : { backend: type };
    },
  };
}

test("operation bridge exposes one immutable catalog of built-in operation ids", () => {
  assert.ok(Object.isFrozen(SUPPORTED_OPERATION_IDS));
  assert.ok(SUPPORTED_OPERATION_IDS.includes("task.create"));
  assert.ok(SUPPORTED_OPERATION_IDS.includes("gate.resolve"));
  assert.ok(SUPPORTED_OPERATION_IDS.includes("knowledge.deprecate"));
  assert.ok(SUPPORTED_OPERATION_IDS.includes("initiative.create"));
  assert.ok(SUPPORTED_OPERATION_IDS.includes("core.batch"));
  assert.equal(new Set(SUPPORTED_OPERATION_IDS).size, SUPPORTED_OPERATION_IDS.length);
  assert.equal(remoteV1Manifest.version, 1);
  for (const { id } of remoteV1Manifest.operations) {
    assert.ok(SUPPORTED_OPERATION_IDS.includes(id), `${id} remains in the bridge catalog`);
  }
  assert.equal(SUPPORTED_OPERATION_IDS.filter((id) => id === remoteV1Manifest.batch.id).length, 1);
});

test("operation bridge selects the local backend and delegates operation and batch once", async () => {
  const calls = [];
  const bridge = createOperationBridge({ backendClient: backendClient("local", calls) });
  const operation = { actor: "alice", operation: "task.create", input: { id: "T1" } };
  const batch = { actor: "alice", operations: [{ operation: "task.create", input: { id: "T2" } }] };

  assert.deepEqual(await bridge.executeOperation(operation), { backend: "local" });
  assert.deepEqual(await bridge.executeBatch(batch), { backend: "local" });
  assert.deepEqual(calls, [
    { method: "executeOperation", args: operation },
    { method: "executeBatch", args: batch },
  ]);
});

test("operation bridge selects remote backend without invoking local execution dependencies", async () => {
  const calls: Array<{ method: string; args: OperationCall }> = [];
  let localCalls = 0;
  const bridge = createOperationBridge(({
    backendClient: backendClient("remote", calls),
    local: {
      loadPolicy() { localCalls += 1; },
      mutate() { localCalls += 1; },
      readMetadata() { localCalls += 1; },
    },
  } as unknown as Parameters<typeof createOperationBridge>[0]));

  assert.deepEqual(await bridge.executeOperation({ actor: "alice", operation: "task.create", input: {} }), { backend: "remote" });
  assert.deepEqual(await bridge.executeBatch({ actor: "alice", operations: [] }), { backend: "remote" });
  assert.equal(localCalls, 0);
  assert.deepEqual(calls.map(({ method }) => method), ["executeOperation", "executeBatch"]);
});

test("operation bridge rejects unsupported ids before delegation and does not fallback after remote failure", async () => {
  const calls: Array<{ method: string; args: OperationCall }> = [];
  const failure = Object.assign(new Error("remote auth failed"), { code: "AUTH_REQUIRED" });
  const bridge = createOperationBridge({
    backendClient: backendClient("remote", calls, {
      executeOperation() { throw failure; },
    }),
  });

  await assert.rejects(
    bridge.executeOperation({ actor: "alice", operation: "plugin.custom", input: {} }),
    (error) => {
      const caught = error as { code?: string; details?: Record<string, unknown> };
      return caught.code === "REMOTE_UNSUPPORTED_OPERATION" && caught.details?.operation === "plugin.custom";
    },
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    bridge.executeOperation({ actor: "alice", operation: "task.create", input: {} }),
    (error) => error === failure,
  );
  assert.equal(calls.length, 1);
});
