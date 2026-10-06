import test from "node:test";
import assert from "node:assert/strict";

import { isSatisfiedV2, isTaskReady } from "../src/providers/task/derivation.ts";

function state(nodes, edges = []) {
  return { version: 2, initiatives: {}, nodes, edges, log: [] };
}

const task = (id, status = "open") => ({
  id,
  kind: "resolvable",
  subkind: "task",
  status,
});

const gate = (id, status = "open") => ({
  id,
  kind: "resolvable",
  subkind: "gate",
  status,
});

test("canceled task replaced by a done task satisfies its dependent", () => {
  const graph = state(
    {
      replacement: task("replacement", "done"),
      canceled: task("canceled", "canceled"),
      dependent: task("dependent"),
    },
    [
      { from: "replacement", to: "canceled", type: "SUPERSEDES" },
      { from: "canceled", to: "dependent", type: "BLOCKS" },
    ],
  );

  assert.equal(isSatisfiedV2(graph, "canceled"), true);
  assert.equal(isTaskReady(graph, "dependent"), true);
});

test("canceled task replaced by an archived task satisfies its dependent", () => {
  const graph = state(
    {
      replacement: task("replacement", "archived"),
      canceled: task("canceled", "canceled"),
      dependent: task("dependent"),
    },
    [
      { from: "replacement", to: "canceled", type: "SUPERSEDES" },
      { from: "canceled", to: "dependent", type: "BLOCKS" },
    ],
  );

  assert.equal(isSatisfiedV2(graph, "canceled"), true);
  assert.equal(isTaskReady(graph, "dependent"), true);
});

test("canceled task replaced by an open task keeps blocking its dependent", () => {
  const graph = state(
    {
      replacement: task("replacement", "open"),
      canceled: task("canceled", "canceled"),
      dependent: task("dependent"),
    },
    [
      { from: "replacement", to: "canceled", type: "SUPERSEDES" },
      { from: "canceled", to: "dependent", type: "BLOCKS" },
    ],
  );

  assert.equal(isSatisfiedV2(graph, "canceled"), false);
  assert.equal(isTaskReady(graph, "dependent"), false);
});

test("canceled task without a replacement keeps blocking its dependent", () => {
  const graph = state(
    {
      canceled: task("canceled", "canceled"),
      dependent: task("dependent"),
    },
    [{ from: "canceled", to: "dependent", type: "BLOCKS" }],
  );

  assert.equal(isSatisfiedV2(graph, "canceled"), false);
  assert.equal(isTaskReady(graph, "dependent"), false);
});

test("canceled task follows a two-hop replacement chain to a done task", () => {
  const graph = state(
    {
      first: task("first", "canceled"),
      second: task("second", "canceled"),
      replacement: task("replacement", "done"),
      dependent: task("dependent"),
    },
    [
      { from: "second", to: "first", type: "SUPERSEDES" },
      { from: "replacement", to: "second", type: "SUPERSEDES" },
      { from: "first", to: "dependent", type: "BLOCKS" },
    ],
  );

  assert.equal(isSatisfiedV2(graph, "first"), true);
  assert.equal(isTaskReady(graph, "dependent"), true);
});

test("SUPERSEDES cycle between canceled tasks stays blocked and terminates", () => {
  const graph = state(
    {
      first: task("first", "canceled"),
      second: task("second", "canceled"),
      dependent: task("dependent"),
    },
    [
      { from: "second", to: "first", type: "SUPERSEDES" },
      { from: "first", to: "second", type: "SUPERSEDES" },
      { from: "first", to: "dependent", type: "BLOCKS" },
    ],
  );

  assert.equal(isSatisfiedV2(graph, "first"), false);
  assert.equal(isTaskReady(graph, "dependent"), false);
});

test("gate and knowledge satisfaction behavior remains unchanged", () => {
  const graph = state(
    {
      resolved: gate("resolved", "resolved"),
      superseded: gate("superseded", "superseded"),
      replacement: gate("replacement", "resolved"),
      knowledge: { id: "knowledge", kind: "knowledge", status: "active" },
    },
    [{ from: "replacement", to: "superseded", type: "SUPERSEDES" }],
  );

  assert.equal(isSatisfiedV2(graph, "resolved"), true);
  assert.equal(isSatisfiedV2(graph, "superseded"), true);
  assert.equal(isSatisfiedV2(graph, "knowledge"), false);
  assert.equal(isSatisfiedV2(graph, "missing"), false);
});
