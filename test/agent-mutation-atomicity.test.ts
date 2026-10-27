// A missing actor must fail before any state or log write.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
} from "./helpers.ts";

function clearAgentEnv() {
  const previous = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  return () => {
    if (previous === undefined) {delete process.env.CLIMIER_AGENT;}
    else {process.env.CLIMIER_AGENT = previous;}
  };
}

async function freshProject(dir) {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  await init({ statePath: dir, positional: [], projectDir: dir });
}

async function seedEdgeProject(dir) {
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  for (const [id, subkind] of [["T-a", "task"], ["G-b", "gate"]]) {
    await addNode({
      statePath: dir,
      positional: [id],
      flags: { kind: "resolvable", subkind, title: id, initiative: "auth", as: "setup" },
    });
  }
}

test("add-node: a missing actor leaves no node and no log entry", async () => {
  const dir = await createTempProject();
  const restore = clearAgentEnv();
  try {
    await freshProject(dir);
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
    await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });

    const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
    let caught;
    try {
      await addNode({
        statePath: dir,
        projectDir: dir,
        positional: ["T-orphan"],
        flags: { kind: "resolvable", subkind: "task", title: "t", initiative: "auth" },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "add-node should throw MISSING_AGENT");
    assert.equal(caught.code, "MISSING_AGENT");

    const state = await readState(dir);
    assert.equal(state.nodes["T-orphan"], undefined, "node must not be created");
    assert.equal(state.log.length, 1, "only the add-initiative entry may exist");
    assert.equal(state.log[0].action, "add-initiative");
  } finally {
    restore();
    await rmTempProject(dir);
  }
});

test("add-edge: a missing actor leaves no edge and no log entry", async () => {
  const dir = await createTempProject();
  const restore = clearAgentEnv();
  try {
    await freshProject(dir);
    await seedEdgeProject(dir);

    const before = await readState(dir);
    const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
    let caught;
    try {
      await addEdge({
        statePath: dir,
        projectDir: dir,
        positional: ["T-a", "G-b"],
        flags: { type: "BLOCKS" },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "add-edge should throw MISSING_AGENT");
    assert.equal(caught.code, "MISSING_AGENT");

    const after = await readState(dir);
    assert.equal(after.edges.length, before.edges.length, "edge must not be added");
    assert.equal(after.log.length, before.log.length, "no log entry may be appended");
  } finally {
    restore();
    await rmTempProject(dir);
  }
});
