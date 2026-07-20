// F5 — CLI surface for BLOCKS edges uses natural language.
// The CLI exposes `--blocked-by <csv>`. Internally the edge direction is
// inverted: "I (this node) am blocked by X" → `{from: X, to: <this node>}`.
// This file is the spec for the user-facing contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, runCli, readState as readRawState } from "./helpers.mjs";

async function bootstrapV2(dir, initiative = "auth") {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "test" }, positional: [initiative] });
}

async function addGate(dir, id, title = id, initiative = "auth", status = "resolved") {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "gate",
      title,
      initiative,
      status,
    },
  });
}

// --- happy path --------------------------------------------------------

test("add-node: --blocked-by produces a single BLOCKS edge with the blocker as `from`", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addGate(dir, "G-y");

    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    await addNode({
      statePath: dir,
      positional: ["T-x"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "Do X",
        initiative: "auth",
        "blocked-by": "G-y",
      },
    });

    const state = await readRawState(dir);
    assert.deepEqual(state.edges, [{ from: "G-y", to: "T-x", type: "BLOCKS" }]);
  } finally {
    await rmTempProject(dir);
  }
});

// --- multi -------------------------------------------------------------

test("add-node: --blocked-by with multiple targets produces one BLOCKS edge per target", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addGate(dir, "G-a");
    await addGate(dir, "G-b");

    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    await addNode({
      statePath: dir,
      positional: ["T-x"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "Do X",
        initiative: "auth",
        "blocked-by": "G-a,G-b",
      },
    });

    const state = await readRawState(dir);
    assert.deepEqual(state.edges, [
      { from: "G-a", to: "T-x", type: "BLOCKS" },
      { from: "G-b", to: "T-x", type: "BLOCKS" },
    ]);
  } finally {
    await rmTempProject(dir);
  }
});

// --- empty -------------------------------------------------------------

test("add-node: --blocked-by with empty string produces zero BLOCKS edges", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    await addNode({
      statePath: dir,
      positional: ["T-x"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "Do X",
        initiative: "auth",
        "blocked-by": "",
      },
    });

    const state = await readRawState(dir);
    assert.deepEqual(state.edges, []);
  } finally {
    await rmTempProject(dir);
  }
});

// --- missing target ----------------------------------------------------

test("add-node: --blocked-by with missing target emits INVALID_EDGE_TARGET", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    await assert.rejects(
      addNode({
        statePath: dir,
        positional: ["T-x"],
        flags: {
          kind: "resolvable",
          subkind: "task",
          title: "Do X",
          initiative: "auth",
          "blocked-by": "G-missing",
        },
      }),
      (err) => err.code === "INVALID_EDGE_TARGET" && /G-missing/.test(err.message),
    );
  } finally {
    await rmTempProject(dir);
  }
});

// --- CLI smoke ---------------------------------------------------------

test("CLI: add-node --blocked-by emits a BLOCKS edge with the blocker as `from`", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "test"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "G-y",
      "--kind", "resolvable", "--subkind", "gate", "--title", "g",
      "--initiative", "auth", "--status", "resolved",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-node", "T-x",
      "--kind", "resolvable", "--subkind", "task", "--title", "Do X",
      "--initiative", "auth",
      "--blocked-by", "G-y",
    ]);
    assert.equal(r.code, 0, r.stderr);

    const state = await readRawState(dir);
    assert.deepEqual(state.edges, [{ from: "G-y", to: "T-x", type: "BLOCKS" }]);
  } finally {
    await rmTempProject(dir);
  }
});