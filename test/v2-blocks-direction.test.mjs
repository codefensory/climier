import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli, readState as readRawState } from "./helpers.mjs";

// Canonical edge direction contract:
//   { from: "G-y", to: "T-x", type: "BLOCKS" }  ⇔  T-x is BLOCKED-BY G-y.
//
// `climier add-task T-x ... --blocked-by G-y` must persist exactly that shape,
// AND helpers that compute "who blocks T-x" must read incoming edges (where
// edge.to === id), not outgoing (edge.from === id).
//
// F10 surfaced a known inconsistency: blockingForNode uses outgoing edges.
// These tests pin the contract so the fix is straightforward.

test("storage: add-task --blocked-by G-y stores edge {from:G-y, to:T-x, BLOCKS}", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-initiative", "auth-migration", "--desc", "x",
      "--as", "test-agent",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-gate", "G-y",
      "--initiative", "auth-migration",
      "--title", "g",
      "--body", "g",
      "--purpose", "decision", "--resolution-mode", "choice",
      "--as", "test-agent",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli([
      "--project", dir, "add-task", "T-x",
      "--initiative", "auth-migration",
      "--title", "x",
      "--body", "x",
      "--acceptance", "x",
      "--blocked-by", "G-y",
      "--as", "test-agent",
    ]);
    assert.equal(r.code, 0, r.stderr);

    const state = await readRawState(dir);
    assert.deepEqual(state.edges, [{ from: "G-y", to: "T-x", type: "BLOCKS" }]);
  } finally {
    await rmTempProject(dir);
  }
});

test("blockingForNode: T-x sees G-y as blocker (incoming edge, to === id)", async () => {
  const { blockingForNode } = await importFresh("../src/v2.mjs");
  const dir = await createTempProject();
  try {
    const { writeState } = await import("../test/helpers.mjs");
    const { default: write } = await import("../test/helpers.mjs");
    // Direct write
    const state = {
      version: 2,
      initiatives: {},
      nodes: {
        "T-x": {
          id: "T-x", kind: "resolvable", subkind: "task",
          resolution_mode: "labor", title: "x", status: "open",
          initiative: "auth-migration", revision: 1,
        },
        "G-y": {
          id: "G-y", kind: "resolvable", subkind: "gate",
          resolution_mode: "choice", title: "y", status: "open",
          initiative: "auth-migration", purpose: "decision", revision: 1,
        },
      },
      edges: [{ from: "G-y", to: "T-x", type: "BLOCKS" }],
      log: [],
    };

    const blocking = blockingForNode(state, "T-x");
    assert.equal(blocking.length, 1, "T-x should have 1 blocker");
    assert.equal(blocking[0].node.id, "G-y", "blocker is G-y");
    assert.equal(blocking[0].edge_type, "BLOCKS");
  } finally {
    await rmTempProject(dir);
  }
});

test("derivation: T-x with satisfied blocker G-y is ready", async () => {
  const { deriveV2 } = await importFresh("../src/v2.mjs");
  const state = {
    version: 2,
    initiatives: {},
    nodes: {
      "T-x": {
        id: "T-x", kind: "resolvable", subkind: "task",
        resolution_mode: "labor", title: "x", status: "open",
        initiative: "auth-migration", revision: 1,
      },
      "G-y": {
        id: "G-y", kind: "resolvable", subkind: "gate",
        resolution_mode: "choice", title: "y", status: "resolved",
        initiative: "auth-migration", purpose: "decision",
        resolution: { choice: "x", rationale: "x" },
        revision: 1,
      },
    },
    edges: [{ from: "G-y", to: "T-x", type: "BLOCKS" }],
    log: [],
  };
  const d = deriveV2(state);
  assert.ok(d.ready.includes("T-x"), "T-x should be ready");
  assert.ok(!d.blocked.includes("T-x"));
});

// Helper
async function importFresh(rel) {
  const url = new URL(rel, import.meta.url).href;
  return import(url + "?t=" + Date.now());
}
