// plugin-compat.test.mjs — DAG and metadata compatibility contracts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveV2, isSatisfiedV2 } from "../src/providers/task/derivation.mjs";
import { statusOf as statusOfV2 } from "../src/read-model/index.mjs";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
  writeCanonicalState,
  bootstrapState,
  submitAcceptTask,
} from "./plugin-compat-helpers.mjs";

test("deriveV2 does not consume `plugins` or `nodes[id].plugins` (ready/blocked unchanged)", async () => {
  const withoutPlugins = {
    version: 2,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", title: "T1", status: "open", revision: 1 },
      T2: { id: "T2", kind: "resolvable", subkind: "task", title: "T2", status: "open", revision: 1 },
      G1: { id: "G1", kind: "resolvable", subkind: "gate", title: "G1", status: "open", revision: 1 },
    },
    edges: [{ from: "G1", to: "T1", type: "BLOCKS" }],
    initiatives: {},
    log: [],
  };
  const withPlugins = JSON.parse(JSON.stringify(withoutPlugins));
  withPlugins.plugins = { "example.audit": { data: { counter: 7 } } };
  withPlugins.nodes.T1.plugins = { "example.audit": { data: { perNode: "T1" } } };
  withPlugins.nodes.T2.plugins = { "example.metrics": { data: { perNode: "T2" } } };
  // Adding the additive fields must not change derivation.
  const a = deriveV2(withoutPlugins);
  const b = deriveV2(withPlugins);
  assert.deepEqual(b.ready, a.ready);
  assert.deepEqual(b.blocked, a.blocked);
  assert.deepEqual(b.openGates, a.openGates);
  assert.deepEqual(b.backlog, a.backlog);
  // And the specific layout we expect.
  assert.deepEqual(b.ready, ["T2"]);
  assert.deepEqual(b.blocked, ["T1"]);
  assert.deepEqual(b.openGates, ["G1"]);
});

test("statusOfV2 does not consume `plugins` or `nodes[id].plugins`", async () => {
  const node = {
    id: "T1",
    kind: "resolvable",
    subkind: "task",
    title: "T1",
    status: "open",
    revision: 1,
    plugins: { "example.audit": { data: { foo: "bar" } } },
  };
  const state = {
    version: 2,
    plugins: { "example.audit": { data: { foo: "bar" } } },
    nodes: { T1: node },
    edges: [],
    initiatives: {},
    log: [],
  };
  assert.equal(statusOfV2(state, "T1"), "ready");
});

test("isSatisfiedV2 does not consume `nodes[id].plugins`", async () => {
  const done = {
    id: "T1",
    kind: "resolvable",
    subkind: "task",
    title: "T1",
    status: "done",
    revision: 1,
    plugins: { "example.audit": { data: { perNode: "T1" } } },
  };
  const state = {
    version: 2,
    plugins: {},
    nodes: { T1: done },
    edges: [],
    initiatives: {},
    log: [],
  };
  assert.equal(isSatisfiedV2(state, "T1"), true);
});

test("`meta` and `nodes[id].plugins` survive take together (disjoint keyspaces)", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes.T1.meta = {
        execution: { effort: "S", risk: "low", checks: ["npm test"] },
      };
      s.nodes.T1.plugins = { "example.audit": { data: { x: 1 } } };
    });
    await writeCanonicalState(dir, base);
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const after = await readState(dir);
    assert.deepEqual(after.nodes.T1.meta, {
      execution: { effort: "S", risk: "low", checks: ["npm test"] },
    });
    assert.deepEqual(after.nodes.T1.plugins, { "example.audit": { data: { x: 1 } } });
  } finally {
    await rmTempProject(dir);
  }
});

test("`meta` and `nodes[id].plugins` survive submit + accept (task) together", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes.T1.meta = { execution: { effort: "M", risk: "integration", checks: ["npm test"] } };
      s.nodes.T1.plugins = { "example.audit": { data: { x: 2 } } };
    });
    await writeCanonicalState(dir, base);
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    await submitAcceptTask(dir);
    const after = await readState(dir);
    assert.deepEqual(after.nodes.T1.meta, {
      execution: { effort: "M", risk: "integration", checks: ["npm test"] },
    });
    assert.deepEqual(after.nodes.T1.plugins, { "example.audit": { data: { x: 2 } } });
  } finally {
    await rmTempProject(dir);
  }
});
