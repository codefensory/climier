// Canonical task derivation tests (ADR-011 §2, ADR-012 §3).
// The provider owns pure status, satisfaction and readiness semantics.

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveV2,
  isSatisfiedV2,
  isTaskReady,
  readiness,
  statusOfV2,
} from "../src/providers/task/derivation.mjs";
import { taskTakeProvider } from "../src/providers/task/index.mjs";

function state(nodes, edges = []) {
  return { version: 2, initiatives: {}, nodes, edges, log: [] };
}

const task = (id, status = "open", extra = {}) => ({
  id,
  kind: "resolvable",
  subkind: "task",
  status,
  ...extra,
});

const gate = (id, status = "open") => ({
  id,
  kind: "resolvable",
  subkind: "gate",
  status,
});

test("task derivation is pure and preserves ready, blocked, backlog and lifecycle statuses", () => {
  const input = state(
    {
      done: task("done", "done"),
      ready: task("ready"),
      blocked: task("blocked"),
      backlog: task("backlog", "open", { backlog: true }),
      working: task("working", "in_progress"),
    },
    [{ from: "done", to: "ready", type: "BLOCKS" }, { from: "missing", to: "blocked", type: "BLOCKS" }],
  );
  const before = structuredClone(input);

  assert.deepEqual(deriveV2(input), {
    ready: ["ready"],
    blocked: ["blocked"],
    backlog: ["backlog"],
    openGates: [],
  });
  assert.equal(statusOfV2(input, "ready"), "ready");
  assert.equal(statusOfV2(input, "blocked"), "blocked");
  assert.equal(statusOfV2(input, "backlog"), "backlog");
  assert.equal(statusOfV2(input, "working"), "in_progress");
  assert.deepEqual(input, before, "derivation must not mutate its input state");
});

test("task satisfaction follows superseded gate chains and remains safe on cycles/missing blockers", () => {
  const graph = state(
    {
      old: gate("old", "superseded"),
      newer: gate("newer", "resolved"),
      cycleA: gate("cycleA", "superseded"),
      cycleB: gate("cycleB", "superseded"),
      target: task("target"),
    },
    [
      { from: "newer", to: "old", type: "SUPERSEDES" },
      { from: "cycleB", to: "cycleA", type: "SUPERSEDES" },
      { from: "cycleA", to: "cycleB", type: "SUPERSEDES" },
      { from: "old", to: "target", type: "BLOCKS" },
    ],
  );

  assert.equal(isSatisfiedV2(graph, "old"), true);
  assert.equal(isSatisfiedV2(graph, "cycleA"), false);
  assert.equal(isSatisfiedV2(graph, "missing"), false);
  assert.equal(isTaskReady(graph, "target"), true);
  assert.equal(readiness(graph, "target"), true);
});

test("submitted tasks are explicit non-open lifecycle and do not satisfy blockers", () => {
  const graph = state(
    {
      submitted: task("submitted", "submitted"),
      descendant: task("descendant"),
    },
    [{ from: "submitted", to: "descendant", type: "BLOCKS" }],
  );

  assert.equal(isSatisfiedV2(graph, "submitted"), false);
  assert.equal(isTaskReady(graph, "submitted"), false);
  assert.equal(statusOfV2(graph, "submitted"), "submitted");
  assert.deepEqual(deriveV2(graph), {
    ready: [],
    blocked: ["descendant"],
    backlog: [],
    openGates: [],
  });

  graph.nodes.submitted.status = "done";
  assert.equal(isSatisfiedV2(graph, "submitted"), true);
  assert.equal(isTaskReady(graph, "descendant"), true);
  assert.equal(statusOfV2(graph, "descendant"), "ready");
});

test("task.take consumes canonical readiness for superseded gates", async () => {
  const snapshot = state(
    {
      old: gate("old", "superseded"),
      newer: gate("newer", "resolved"),
      target: task("target"),
    },
    [
      { from: "newer", to: "old", type: "SUPERSEDES" },
      { from: "old", to: "target", type: "BLOCKS" },
    ],
  );

  const plan = await taskTakeProvider.prepare({
    snapshot,
    input: { id: "target", actor: "alice", at: "2026-01-01T00:00:00.000Z" },
    request: {},
  });
  assert.equal(plan.idempotent, false);
  assert.equal(plan.target.id, "target");
});
