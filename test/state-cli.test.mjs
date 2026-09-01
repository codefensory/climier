import test from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  runCli,
  writeState,
} from "./helpers.mjs";

function currentState() {
  return {
    version: 4,
    revision: 17,
    initiatives: {},
    nodes: {
      "T-z": {
        id: "T-z",
        kind: "resolvable",
        subkind: "task",
        title: "Current task",
        status: "open",
        plugins: {
          "plugin.a": { data: { private: "a" } },
          "plugin.b": { data: { private: "b" } },
        },
      },
      "G-open": {
        id: "G-open",
        kind: "resolvable",
        subkind: "gate",
        title: "Current gate",
        status: "open",
      },
    },
    edges: [
      { from: "T-z", to: "G-open", type: "DERIVED_FROM" },
      { from: "G-open", to: "T-z", type: "BLOCKS" },
    ],
    plugins: {
      "plugin.a": { data: { project: "a" } },
      "plugin.b": { data: { project: "b" } },
    },
    log: [],
  };
}

test("CLI state returns the deterministic current core projection without plugin namespaces", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, currentState());

    const result = await runCli(["--project", dir, "state"]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);

    assert.deepEqual(Object.keys(output), ["revision", "nodes", "edges", "derived", "plugins"]);
    assert.equal(output.revision, 17);
    assert.deepEqual(Object.keys(output.nodes), ["G-open", "T-z"]);
    assert.deepEqual(output.edges, [
      { from: "G-open", to: "T-z", type: "BLOCKS" },
      { from: "T-z", to: "G-open", type: "DERIVED_FROM" },
    ]);
    assert.deepEqual(output.derived, { "G-open": "open", "T-z": "blocked" });
    assert.deepEqual(output.plugins, {});
    assert.equal(output.nodes["T-z"].plugins, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI state is a current-state read, separate from historical snapshots", async () => {
  const dir = await createTempProject();
  try {
    let result = await runCli(["--project", dir, "init"]);
    assert.equal(result.code, 0, result.stderr);
    await writeState(dir, currentState());

    result = await runCli(["--project", dir, "init", "--force", "--as", "setup"]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

    const state = await runCli(["--project", dir, "state"]);
    assert.equal(state.code, 0, state.stderr);
    const output = JSON.parse(state.stdout);
    assert.equal(output.revision, 18);
    assert.deepEqual(output.nodes, {});

    const snapshots = await runCli(["--project", dir, "snapshots"]);
    assert.equal(snapshots.code, 0, snapshots.stderr);
    const historical = JSON.parse(snapshots.stdout);
    assert.ok(historical.snapshots.length > 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI help and reserved namespaces include state", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /\bstate\b/);

  const { RESERVED_NAMESPACES } = await import("../src/cli/commands/reserved-namespaces.mjs");
  assert.ok(RESERVED_NAMESPACES.includes("state"));
});
