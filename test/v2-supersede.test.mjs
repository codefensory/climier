import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState as readRawState,
} from "./helpers.mjs";

async function setup(dir) {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInitiative } = await importFresh("./commands/add-initiative.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInitiative({ statePath: dir, flags: { desc: "test" }, positional: ["work"] });
}

test("add-gate --supersedes atomically replaces the gate and rewrites incoming BLOCKS", async () => {
  const dir = await createTempProject();
  try {
    await setup(dir);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");
    const { default: addGate } = await importFresh("./commands/add-gate.mjs");
    const { default: addEdge } = await importFresh("./commands/add-edge.mjs");

    await addTask({
      statePath: dir,
      positional: ["T1"],
      flags: { initiative: "work", title: "Blocker", body: "Block", acceptance: "Done", "blocked-by": "" },
    });
    await addGate({
      statePath: dir,
      positional: ["G-A"],
      flags: { initiative: "work", title: "Old gate", body: "Old", purpose: "choice" },
    });
    await addEdge({
      statePath: dir,
      positional: ["T1", "G-A"],
      flags: { type: "BLOCKS" },
    });
    await addGate({
      statePath: dir,
      positional: ["G-B"],
      flags: { initiative: "work", title: "New gate", body: "New", purpose: "choice", supersedes: "G-A", as: "alice" },
    });

    const state = await readRawState(dir);
    assert.equal(state.nodes["G-B"].revision, 1);
    assert.equal(state.nodes["G-A"].status, "superseded");
    assert.equal(state.nodes["G-A"].revision, 2);
    assert.ok(state.edges.some((edge) =>
      edge.from === "G-B" && edge.to === "G-A" && edge.type === "SUPERSEDES"
    ));
    assert.ok(state.edges.some((edge) =>
      edge.from === "T1" && edge.to === "G-B" && edge.type === "BLOCKS"
    ));
    assert.ok(!state.edges.some((edge) =>
      edge.from === "T1" && edge.to === "G-A" && edge.type === "BLOCKS"
    ));
    assert.equal(state.log.at(-1).action, "supersede");
    assert.equal(state.log.at(-1).agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task rejects --supersedes with INVALID_EDGE_KIND", async () => {
  const dir = await createTempProject();
  try {
    await setup(dir);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");
    const { default: addGate } = await importFresh("./commands/add-gate.mjs");
    await addGate({
      statePath: dir,
      positional: ["G-A"],
      flags: { initiative: "work", title: "Gate", body: "Gate", purpose: "choice" },
    });

    await assert.rejects(
      addTask({
        statePath: dir,
        positional: ["T1"],
        flags: { initiative: "work", title: "Task", body: "Task", acceptance: "Done", "blocked-by": "", supersedes: "G-A" },
      }),
      (err) => err.code === "INVALID_EDGE_KIND" && /supersedes/i.test(err.message),
    );
    const state = await readRawState(dir);
    assert.equal(state.nodes.T1, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gate --supersedes rejects a missing target atomically", async () => {
  const dir = await createTempProject();
  try {
    await setup(dir);
    const { default: addGate } = await importFresh("./commands/add-gate.mjs");

    await assert.rejects(
      addGate({
        statePath: dir,
        positional: ["G-B"],
        flags: { initiative: "work", title: "New gate", body: "New", purpose: "choice", supersedes: "missing" },
      }),
      (err) => err.code === "INVALID_EDGE_TARGET" && err.details.missing === "missing",
    );
    const state = await readRawState(dir);
    assert.equal(state.nodes["G-B"], undefined);
    assert.deepEqual(state.edges, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gate --supersedes rejects a knowledge target atomically", async () => {
  const dir = await createTempProject();
  try {
    await setup(dir);
    const { default: addGate } = await importFresh("./commands/add-gate.mjs");
    const { default: addKnowledge } = await importFresh("./commands/add-knowledge.mjs");
    await addKnowledge({
      statePath: dir,
      positional: ["K-A"],
      flags: { initiative: "work", title: "Knowledge", body: "Knowledge", "scope-domains": "work" },
    });

    await assert.rejects(
      addGate({
        statePath: dir,
        positional: ["G-B"],
        flags: { initiative: "work", title: "Gate", body: "Gate", purpose: "choice", supersedes: "K-A" },
      }),
      (err) => err.code === "INVALID_EDGE_KIND" && /SUPERSEDES/.test(err.message),
    );
    const state = await readRawState(dir);
    assert.equal(state.nodes["G-B"], undefined);
    assert.equal(state.nodes["K-A"].status, "active");
    assert.deepEqual(state.edges, []);
  } finally {
    await rmTempProject(dir);
  }
});
