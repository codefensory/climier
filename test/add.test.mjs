// add-task, add-gate, add-knowledge, add-initiative: v2 surface only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

test("add-task: appends a new task to state via the v2 wrapper", async () => {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["migration"] });
    const out = await addTask({
      statePath: dir,
      flags: { initiative: "migration", title: "first", body: "spec", acceptance: "done", "blocked-by": "", domain: "db" },
      positional: ["T1"],
    });
    assert.equal(out.node.title, "first");
    assert.equal(out.node.initiative, "migration");
    assert.equal(out.node.domain, "db");
    const s = await readState(dir);
    assert.equal(s.nodes.T1.title, "first");
    assert.equal(s.nodes.T1.kind, "resolvable");
    assert.equal(s.nodes.T1.subkind, "task");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: --blocked-by attaches BLOCKS edges", async () => {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "x", body: "a", acceptance: "a", "blocked-by": "" }, positional: ["T1"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "y", body: "b", acceptance: "b", "blocked-by": "T1" }, positional: ["T2"] });
    const s = await readState(dir);
    const blocks = s.edges.filter((e) => e.type === "BLOCKS" && e.to === "T2");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].from, "T1");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: rejects duplicate id", async () => {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await addTask({ statePath: dir, flags: { initiative: "mig", title: "x", body: "a", acceptance: "a", "blocked-by": "" }, positional: ["T1"] });
    await assert.rejects(
      addTask({ statePath: dir, flags: { initiative: "mig", title: "y", body: "a", acceptance: "a", "blocked-by": "" }, positional: ["T1"] }),
      /already|exists|conflict|ID_CONFLICT/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-initiative: registers an initiative with description", async () => {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "the big migration" }, positional: ["migration"] });
    const s = await readState(dir);
    assert.equal(s.initiatives.migration.desc, "the big migration");
    assert.ok(s.initiatives.migration.created_at);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gate: appends a gate node", async () => {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addGate } = await importFresh("./cli/commands/add-gate.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    const out = await addGate({
      statePath: dir,
      flags: { initiative: "mig", title: "decide auth", body: "spec", purpose: "decision" },
      positional: ["G-auth"],
    });
    assert.equal(out.node.title, "decide auth");
    assert.equal(out.node.kind, "resolvable");
    assert.equal(out.node.subkind, "gate");
    const s = await readState(dir);
    assert.ok(s.nodes["G-auth"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-knowledge: appends a scoped knowledge node", async () => {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const { default: addKnowledge } = await importFresh("./cli/commands/add-knowledge.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    const out = await addKnowledge({
      statePath: dir,
      flags: { initiative: "mig", title: "RLS gotcha", body: "spec", "scope-domains": "db" },
      positional: ["K-rls"],
    });
    assert.equal(out.node.kind, "knowledge");
    assert.deepEqual(out.node.scope.domains, ["db"]);
  } finally {
    await rmTempProject(dir);
  }
});