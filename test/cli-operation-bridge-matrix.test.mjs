import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_CORE_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_TASK_OPS,
} from "../src/application/operations/builtins.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

// Closure inventory for ordinary CLI writes. The existing command and HTTP
// suites named per row exercise the actual input, selected policy, public
// envelope/error, audit log, and resulting state; this table keeps their
// bridge ownership and compatibility expectations reviewable in one place.
const writes = [
  {
    operation: "task.create", commands: ["add-task", "add-node(task)"],
    input: "id, initiative, title, body, acceptance, blocked_by, tags, refs, meta",
    policyAction: "task.create", envelope: "{ node }", error: "MISSING_FIELD / INVALID_ID",
    logAction: "add-task / add-node", state: "created task, revision, and blocker edges",
    local: "add-wrappers.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.update", commands: ["update(task)"],
    input: "id, changes, if_revision; legacy fields share the operation input",
    policyAction: "task.update", envelope: "{ node }", error: "NODE_NOT_FOUND / REVISION_CONFLICT",
    logAction: "update", state: "updated task and revision; idempotence preserves both",
    local: "update.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.take", commands: ["take"],
    input: "id, actor (local); id (remote)",
    policyAction: "task.takeover only for a different existing owner",
    envelope: "{ node, context, freshly_claimed }", error: "ALREADY_CLAIMED / POLICY_DENIED",
    logAction: "take", state: "claim/status change; denied and idempotent calls do not mutate",
    local: "cli-takeover-policy-seam.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.release", commands: ["release"],
    input: "id, actor (local); id (remote)", policyAction: "task.release",
    envelope: "{ released, node }", error: "NODE_NOT_FOUND / POLICY_DENIED",
    logAction: "release", state: "claim cleared and task open",
    local: "cli-remote-resolvable-lifecycle-routing.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.reopen", commands: ["reopen(task)"], input: "id, reason",
    policyAction: "task.reopen", envelope: "{ node }", error: "INVALID_STATUS / POLICY_DENIED",
    logAction: "task.reopen", state: "task open and terminal fields cleared",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.cancel", commands: ["cancel(task)"], input: "id, reason",
    policyAction: "task.cancel", envelope: "{ node }", error: "INVALID_STATUS / POLICY_DENIED",
    logAction: "task.cancel", state: "task canceled and terminal fields cleared",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.submit", commands: ["submit"], input: "id, note, actor (local); id, note (remote)",
    policyAction: "task.submit", envelope: "{ node, newly_ready }", error: "INVALID_STATUS / POLICY_DENIED",
    logAction: "task.submit", state: "task submitted",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.accept", commands: ["accept"], input: "id, actor (local); id (remote)",
    policyAction: "task.accept", envelope: "{ node, newly_ready }", error: "INVALID_STATUS / POLICY_DENIED",
    logAction: "task.accept", state: "task done",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "task.reject", commands: ["reject"], input: "id, reason, actor (local); id, reason (remote)",
    policyAction: "task.reject", envelope: "{ node }", error: "MISSING_FIELD / INVALID_STATUS",
    logAction: "task.reject", state: "task open with rejection reason",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "gate.create", commands: ["add-gate", "add-node(gate)"],
    input: "id, initiative, title, body, purpose, blocked_by, derived_from",
    policyAction: "gate.create", envelope: "{ node }", error: "MISSING_FIELD / INVALID_EDGE_KIND",
    logAction: "add-node / supersede", state: "created gate and supersedes edge when requested",
    local: "add-wrappers.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "gate.update", commands: ["update(gate)"], input: "id, changes, if_revision",
    policyAction: "gate.update", envelope: "{ node }", error: "NODE_NOT_FOUND / REVISION_CONFLICT",
    logAction: "update", state: "updated gate and revision",
    local: "update.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "gate.resolve", commands: ["resolve"], input: "id, choice, rationale, if_revisions",
    policyAction: "gate.resolve", envelope: "{ node, newly_ready }", error: "INVALID_STATUS / POLICY_DENIED",
    logAction: "gate.resolve", state: "gate resolved; repeated same resolution remains compatible",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "gate.reopen", commands: ["reopen(gate)"], input: "id, reason, if_revisions",
    policyAction: "gate.reopen", envelope: "{ node }", error: "INVALID_STATUS / POLICY_DENIED",
    logAction: "gate.reopen", state: "gate open and resolution fields cleared",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "gate.cancel", commands: ["cancel(gate)"], input: "id, reason, if_revisions",
    policyAction: "gate.cancel", envelope: "{ node }", error: "INVALID_STATUS / POLICY_DENIED",
    logAction: "gate.cancel", state: "gate canceled and terminal fields cleared",
    local: "task-lifecycle-cli.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "knowledge.create", commands: ["add-knowledge", "add-node(knowledge)"],
    input: "id, initiative, title, body, scope, refs, derived_from",
    policyAction: "knowledge.create", envelope: "{ node }", error: "MISSING_FIELD / INVALID_EDGE_KIND",
    logAction: "add-node / supersede", state: "created knowledge and supersedes edge when requested",
    local: "add-wrappers.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "knowledge.update", commands: ["update(knowledge)"], input: "id, changes, if_revision",
    policyAction: "knowledge.update", envelope: "{ node }", error: "NODE_NOT_FOUND / REVISION_CONFLICT",
    logAction: "update", state: "updated knowledge and revision",
    local: "update.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "knowledge.deprecate", commands: ["deprecate-knowledge"], input: "id, reason",
    policyAction: "knowledge.deprecate", envelope: "{ node }", error: "MISSING_FIELD / INVALID_STATUS",
    logAction: "knowledge.deprecate", state: "knowledge deprecated",
    local: "provider-knowledge-deprecate.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "initiative.create", commands: ["add-initiative"], input: "name, desc",
    policyAction: "initiative.create", envelope: "{ initiative }", error: "MISSING_FIELD / INVALID_REQUEST",
    logAction: "initiative.create", state: "initiative created",
    local: "initiative-validation.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "note.add", commands: ["add-note"], input: "id, text, if_revision",
    policyAction: "note.add", envelope: "{ node }", error: "MISSING_FIELD / NODE_NOT_FOUND / REVISION_CONFLICT",
    logAction: "note.add", state: "note appended and node revision incremented",
    local: "add-note.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "edge.add", commands: ["add-edge"], input: "from, to, type",
    policyAction: "edge.add", envelope: "{ edge }", error: "INVALID_EDGE_KIND / NODE_NOT_FOUND",
    logAction: "edge.add", state: "edge appended",
    local: "provider-core-edge.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "edge.remove", commands: ["remove-edge"], input: "from, to, type",
    policyAction: "edge.remove", envelope: "{ removed }", error: "INVALID_EDGE_KIND / NODE_NOT_FOUND",
    logAction: "edge.remove", state: "matching edge removed",
    local: "edge-remove.test.mjs", remote: "cli-remote-write-routing.test.mjs",
  },
  {
    operation: "core.batch", commands: ["batch"], input: "operations[], if_state_revision",
    policyAction: "core.batch", envelope: "{ ok, results }", error: "INVALID_REQUEST / REVISION_CONFLICT",
    logAction: "per-operation audit entries in the one batch transaction",
    state: "all operations commit atomically or none commit",
    local: "cli-operation-bridge-boundary.test.mjs", remote: "cli-remote-write-routing.test.mjs",
    http: "server/http/operations-batch.test.mjs",
  },
];

const adapterBridgeMarkers = [
  ["take", "executeOperation("],
  ["release", "createOperationBridge("],
  ["submit", "createOperationBridge("],
  ["accept", "createOperationBridge("],
  ["reject", "createOperationBridge("],
  ["resolve", "executeOperation("],
  ["reopen", "executeOperation("],
  ["cancel", "executeOperation("],
  ["update", "createOperationBridge("],
  ["add-task", "addV2Node("],
  ["add-gate", "addV2Node("],
  ["add-knowledge", "addV2Node("],
  ["add-node", "createOperationBridge("],
  ["add-initiative", "executeOperation("],
  ["add-note", "executeOperation("],
  ["add-edge", "executeOperation("],
  ["remove-edge", "executeOperation("],
  ["deprecate-knowledge", "executeOperation("],
];

const exceptions = [
  {
    command: "init", owner: "kernel/state-operations.mjs:initState",
    path: "src/cli/commands/init.mjs", markers: ["initState(", "backendClient.init()"],
    tests: ["init.test.mjs", "kernel-state-operations.test.mjs", "server/http/auth-validation.test.mjs"],
  },
  {
    command: "restore", owner: "kernel/state-operations.mjs:restoreState",
    path: "src/cli/commands/restore.mjs", markers: ["restoreState("],
    tests: ["snapshots-restore.test.mjs", "kernel-state-operations.test.mjs", "cli-remote-write-routing.test.mjs"],
  },
];

async function sourceAt(relativePath) {
  return await fs.readFile(path.resolve(TEST_DIR, "..", relativePath), "utf8");
}

function assertTestFiles(files) {
  for (const file of files) {
    assert.ok(file.endsWith(".test.mjs"), `test owner is a focused test file: ${file}`);
  }
}

test("write matrix covers every registered operation and documents local/remote contracts", async () => {
  const catalog = [...PUBLIC_TASK_OPS, ...PUBLIC_GATE_OPS, ...PUBLIC_KNOWLEDGE_OPS, ...PUBLIC_CORE_OPS];
  const matrix = writes.map(({ operation }) => operation);
  assert.deepEqual([...matrix].filter((operation) => operation !== "core.batch").toSorted(), [...catalog].toSorted(), "every registered operation has one matrix row");
  assert.ok(matrix.includes("core.batch"), "batch's descriptor is also represented");
  assert.equal(new Set(matrix).size, matrix.length, "matrix operation ids are unique");
  const batch = writes.find(({ operation }) => operation === "core.batch");
  assertTestFiles([batch.http]);

  for (const row of writes) {
    for (const field of ["commands", "input", "policyAction", "envelope", "error", "logAction", "state", "local", "remote"]) {
      assert.ok(row[field], `${row.operation} documents ${field}`);
    }
    assertTestFiles([row.local, row.remote]);
    for (const file of [row.local, row.remote, ...(row.http ? [row.http] : [])]) {
      await fs.access(path.resolve(TEST_DIR, file));
    }
  }
});

test("ordinary write adapters route through the operation bridge", async () => {
  for (const [command, marker] of adapterBridgeMarkers) {
    const source = await sourceAt(`src/cli/commands/${command}.mjs`);
    assert.ok(source.includes(marker), `${command} adapter delegates via ${marker.trim()}`);
    if (command === "take") {
      assert.match(source, /source:\s*takeSource\(/, "take keeps its narrowly scoped CLI provider/policy compatibility source");
      assert.match(source, /executeOperation\(/, "take's compatibility source delegates to the Application Operations pipeline");
    }
  }

  const batch = await sourceAt("src/cli/commands/batch.mjs");
  assert.ok(batch.includes("executeBatch("), "batch delegates to the bridge batch operation");
});

test("init and restore remain owned kernel exceptions", async () => {
  for (const exception of exceptions) {
    const source = await sourceAt(exception.path);
    for (const marker of exception.markers) {
      assert.ok(source.includes(marker), `${exception.command} is owned by ${exception.owner} via ${marker}`);
    }
    assertTestFiles(exception.tests);
    for (const file of exception.tests) {
      await fs.access(path.resolve(TEST_DIR, file));
    }
    if (exception.downstream) {
      assert.equal(exception.downstream, "T-rar-032-transfers");
    }
  }
});
