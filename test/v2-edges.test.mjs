// F1 — centralized edge validation for v2.
// Pure-function tests cover validateEdge / existingEdge / v2Error.
// Integration tests cover add-edge and add-node end-to-end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, runCli } from "./helpers.mjs";

// --- pure helpers -------------------------------------------------------

function makeState(nodes = {}, edges = []) {
  return {
    version: 2,
    nodes,
    edges,
    log: [],
  };
}

const resolvableTask = (id) => ({ id, kind: "resolvable", subkind: "task", title: id });
const resolvableGate = (id) => ({ id, kind: "resolvable", subkind: "gate", title: id });
const knowledgeNode = (id) => ({ id, kind: "knowledge", title: id });

test("throwV2: re-exported from v2.mjs, throws an Error with code, message, and details", async () => {
  const { throwV2 } = await importFresh("./v2.mjs");
  let caught;
  try {
    throwV2("SOMETHING", "it broke", { foo: 1 });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "it broke");
  assert.equal(caught.code, "SOMETHING");
  assert.deepEqual(caught.details, { foo: 1 });
  assert.deepEqual(caught.toJSON(), { ok: false, error: { code: "SOMETHING", message: "it broke", details: { foo: 1 } } });
});

test("EDGE_TYPES: lists BLOCKS, SUPERSEDES, DERIVED_FROM only", async () => {
  const { EDGE_TYPES } = await importFresh("./v2.mjs");
  assert.deepEqual([...EDGE_TYPES].sort(), ["BLOCKS", "DERIVED_FROM", "SUPERSEDES"]);
});

test("existingEdge: matches on exact (from, to, type) triple", async () => {
  const { existingEdge } = await importFresh("./v2.mjs");
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B") },
    [{ from: "A", to: "B", type: "BLOCKS" }],
  );
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), true);
});

test("existingEdge: returns false when type differs", async () => {
  const { existingEdge } = await importFresh("./v2.mjs");
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B") },
    [{ from: "A", to: "B", type: "BLOCKS" }],
  );
  assert.equal(existingEdge(state, "A", "B", "SUPERSEDES"), false);
});

test("existingEdge: returns false on empty / unrelated edges", async () => {
  const { existingEdge } = await importFresh("./v2.mjs");
  const state = makeState({ A: resolvableTask("A"), B: resolvableGate("B") }, []);
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), false);
});

// --- validateEdge -------------------------------------------------------

test("validateEdge: self-edge is rejected with code SELF_EDGE", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ T1: resolvableTask("T1") });
  assert.throws(
    () => validateEdge(state, { from: "T1", to: "T1", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "SELF_EDGE" && /self-edge/i.test(err.message),
  );
});

test("validateEdge: missing from-node is rejected with code INVALID_EDGE_TARGET", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ B: resolvableGate("B") });
  assert.throws(
    () => validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_TARGET" && /A/.test(err.message),
  );
});

test("validateEdge: missing to-node is rejected with code INVALID_EDGE_TARGET", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ A: resolvableTask("A") });
  assert.throws(
    () => validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_TARGET" && /B/.test(err.message),
  );
});

test("validateEdge: BLOCKS requires both ends to be resolvable (to is knowledge)", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ T: resolvableTask("T"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "T", to: "K", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
  );
});

test("validateEdge: BLOCKS requires both ends to be resolvable (from is knowledge)", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ T: resolvableTask("T"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "K", to: "T", type: "BLOCKS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
  );
});

test("validateEdge: SUPERSEDES requires both ends to be the same kind (gate vs knowledge)", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ G: resolvableGate("G"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "G", to: "K", type: "SUPERSEDES" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_KIND" && /SUPERSEDES/.test(err.message),
  );
});

test("validateEdge: SUPERSEDES between gates is accepted", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ G1: resolvableGate("G1"), G2: resolvableGate("G2") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "G1", to: "G2", type: "SUPERSEDES" }, "cmd"),
  );
});

test("validateEdge: SUPERSEDES between knowledge nodes is accepted", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ K1: knowledgeNode("K1"), K2: knowledgeNode("K2") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "K1", to: "K2", type: "SUPERSEDES" }, "cmd"),
  );
});

test("validateEdge: DERIVED_FROM has no extra kind rule", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ K: knowledgeNode("K"), T: resolvableTask("T") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "K", to: "T", type: "DERIVED_FROM" }, "cmd"),
  );
});

test("validateEdge: rejects unknown edge types with code INVALID_EDGE_TYPE", async () => {
  const { validateEdge } = await importFresh("./v2.mjs");
  const state = makeState({ T: resolvableTask("T"), G: resolvableGate("G") });
  assert.throws(
    () => validateEdge(state, { from: "T", to: "G", type: "INFORMS" }, "cmd"),
    (err) => err.code === "INVALID_EDGE_TYPE" && /INFORMS/.test(err.message),
  );
});

// --- add-edge: command integration -------------------------------------

test("add-edge: rejects self-edges with code SELF_EDGE", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await assert.rejects(
      addEdge({ statePath: dir, positional: ["T1", "T1"], flags: { type: "BLOCKS" } }),
      (err) => err.code === "SELF_EDGE",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects missing target nodes with code INVALID_EDGE_TARGET", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await assert.rejects(
      addEdge({ statePath: dir, positional: ["ghost", "also-ghost"], flags: { type: "BLOCKS" } }),
      (err) => err.code === "INVALID_EDGE_TARGET",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects BLOCKS targeting knowledge with code INVALID_EDGE_KIND", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth"] });
    await addNode({
      statePath: dir,
      positional: ["T1"],
      flags: { kind: "resolvable", subkind: "task", title: "t", initiative: "auth" },
    });
    await addNode({
      statePath: dir,
      positional: ["K1"],
      flags: { kind: "knowledge", title: "k", initiative: "auth" },
    });
    await assert.rejects(
      addEdge({ statePath: dir, positional: ["T1", "K1"], flags: { type: "BLOCKS" } }),
      (err) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects SUPERSEDES across kinds with code INVALID_EDGE_KIND", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth"] });
    await addNode({
      statePath: dir,
      positional: ["G1"],
      flags: { kind: "resolvable", subkind: "gate", title: "g", initiative: "auth" },
    });
    await addNode({
      statePath: dir,
      positional: ["K1"],
      flags: { kind: "knowledge", title: "k", initiative: "auth" },
    });
    await assert.rejects(
      addEdge({ statePath: dir, positional: ["G1", "K1"], flags: { type: "SUPERSEDES" } }),
      (err) => err.code === "INVALID_EDGE_KIND" && /SUPERSEDES/.test(err.message),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects duplicate (from, to, type) edges with code DUPLICATE_EDGE", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth"] });
    await addNode({
      statePath: dir,
      positional: ["T1"],
      flags: { kind: "resolvable", subkind: "task", title: "t", initiative: "auth" },
    });
    await addNode({
      statePath: dir,
      positional: ["G1"],
      flags: { kind: "resolvable", subkind: "gate", title: "g", initiative: "auth" },
    });
    await addEdge({
      statePath: dir,
      positional: ["T1", "G1"],
      flags: { type: "BLOCKS" },
    });
    await assert.rejects(
      addEdge({ statePath: dir, positional: ["T1", "G1"], flags: { type: "BLOCKS" } }),
      (err) => err.code === "DUPLICATE_EDGE",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects INFORMS, RELATES_TO, CONFLICTS_WITH with code INVALID_EDGE_TYPE", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth"] });
    await addNode({
      statePath: dir,
      positional: ["T1"],
      flags: { kind: "resolvable", subkind: "task", title: "t", initiative: "auth" },
    });
    await addNode({
      statePath: dir,
      positional: ["T2"],
      flags: { kind: "resolvable", subkind: "task", title: "t2", initiative: "auth" },
    });
    for (const type of ["INFORMS", "RELATES_TO", "CONFLICTS_WITH"]) {
      await assert.rejects(
        addEdge({ statePath: dir, positional: ["T1", "T2"], flags: { type } }),
        (err) => err.code === "INVALID_EDGE_TYPE" && err.message.includes(type),
        `expected ${type} to be rejected with INVALID_EDGE_TYPE`,
      );
    }
  } finally {
    await rmTempProject(dir);
  }
});

// --- add-node: deprecated edge-type flags are no longer accepted ------

test("CLI: --informs, --relates-to, --conflicts-with are no longer recognized flags", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth"] });

    for (const flag of ["informs", "relates-to", "conflicts-with"]) {
      const r = await runCli([
        "--project", dir, "add-node", `Tx-${flag}`,
        "--kind", "resolvable", "--subkind", "task", "--title", `t-${flag}`,
        "--initiative", "auth",
        `--${flag}`, "G1",
      ]);
      assert.equal(r.code, 1, `expected --${flag} to fail, got ${r.stdout}`);
      assert.match(r.stdout, new RegExp(`unknown flag --${flag}`));
    }
  } finally {
    await rmTempProject(dir);
  }
});
