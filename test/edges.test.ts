// Centralized edge validation: pure rules plus add-edge integration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { throwV2 } from "../src/contracts/errors.ts";
import type { ErrorCode } from "../src/contracts/errors.ts";
import { EDGE_TYPES, blocksEdge, existingEdge, validateEdge } from "../src/kernel/edges.ts";
import { createTempProject, rmTempProject, importFresh, runCli } from "./helpers.ts";

// --- pure helpers -------------------------------------------------------

type Edge = { from: string; to: string; type: string };
type TestError = Error & { code?: string; details?: Record<string, unknown>; toJSON(): unknown };

function makeState(nodes: Record<string, object> = {}, edges: Edge[] = []) {
  return {
    version: 1,
    nodes,
    edges,
    log: [],
  };
}

const resolvableTask = (id) => ({ id, kind: "resolvable", subkind: "task", title: id });
const resolvableGate = (id) => ({ id, kind: "resolvable", subkind: "gate", title: id });
const knowledgeNode = (id) => ({ id, kind: "knowledge", title: id });

test("throwV2: throws an Error with code, message, and details", async () => {
  let caught: TestError | undefined;
  try {
    throwV2("SOMETHING" as ErrorCode, "it broke", { foo: 1 });
  } catch (e) {
    caught = e as TestError;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught!.message, "it broke");
  assert.equal(caught!.code, "SOMETHING");
  assert.deepEqual(caught!.details, { foo: 1 });
  assert.deepEqual(caught!.toJSON(), { ok: false, error: { code: "SOMETHING", message: "it broke", details: { foo: 1 } } });
});

test("EDGE_TYPES: lists BLOCKS, SUPERSEDES, DERIVED_FROM only", async () => {
  assert.deepEqual([...EDGE_TYPES].toSorted(), ["BLOCKS", "DERIVED_FROM", "SUPERSEDES"]);
  for (const deprecated of ["INFORMS", "RELATES_TO", "CONFLICTS_WITH"]) {
    assert.equal((EDGE_TYPES as readonly string[]).includes(deprecated), false, `${deprecated} must be rejected`);
  }
});

test("existingEdge: matches on exact (from, to, type) triple", async () => {
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B") },
    [{ from: "A", to: "B", type: "BLOCKS" }],
  );
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), true);
});

test("existingEdge: returns false when type differs", async () => {
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B") },
    [{ from: "A", to: "B", type: "BLOCKS" }],
  );
  assert.equal(existingEdge(state, "A", "B", "SUPERSEDES"), false);
});

test("existingEdge: returns false on empty / unrelated edges", async () => {
  const state = makeState({ A: resolvableTask("A"), B: resolvableGate("B") }, []);
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), false);
});

test("existingEdge: detects duplicates regardless of position", async () => {
  const state = makeState(
    { A: resolvableTask("A"), B: resolvableGate("B"), C: resolvableGate("C") },
    [
      { from: "A", to: "C", type: "BLOCKS" },
      { from: "A", to: "B", type: "BLOCKS" },
      { from: "A", to: "B", type: "BLOCKS" },
    ],
  );
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), true);
  assert.equal(existingEdge(state, "A", "B", "SUPERSEDES"), false);
});

test("existingEdge: handles missing edges field defensively", async () => {
  const state = makeState({ A: resolvableTask("A") });
  delete (state as { edges?: Edge[] }).edges;
  assert.equal(existingEdge(state, "A", "B", "BLOCKS"), false);
});

test("blocksEdge: produces the canonical BLOCKS edge shape", async () => {
  assert.deepEqual(blocksEdge("A", "B"), { from: "A", to: "B", type: "BLOCKS" });
});

test("blocksEdge: direction is 'blocker BLOCKS blocked' (first arg is the blocker)", async () => {
  assert.deepEqual(blocksEdge("G-x", "T-y"), { from: "G-x", to: "T-y", type: "BLOCKS" });
});

test("blocksEdge: returns a fresh object each call", async () => {
  assert.notEqual(blocksEdge("A", "B"), blocksEdge("A", "B"));
  assert.deepEqual(blocksEdge("A", "B"), blocksEdge("A", "B"));
});

// --- validateEdge -------------------------------------------------------

test("validateEdge: self-edge is rejected with code SELF_EDGE", async () => {
  const state = makeState({ T1: resolvableTask("T1") });
  assert.throws(
    () => validateEdge(state, { from: "T1", to: "T1", type: "BLOCKS" }, "cmd"),
    (err: TestError) => err.code === "SELF_EDGE" && /self-edge/i.test(err.message),
  );
});

test("validateEdge: missing from-node is rejected with code INVALID_EDGE_TARGET", async () => {
  const state = makeState({ B: resolvableGate("B") });
  assert.throws(
    () => validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err: TestError) => err.code === "INVALID_EDGE_TARGET" && /A/.test(err.message),
  );
});

test("validateEdge: missing to-node is rejected with code INVALID_EDGE_TARGET", async () => {
  const state = makeState({ A: resolvableTask("A") });
  assert.throws(
    () => validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err: TestError) => err.code === "INVALID_EDGE_TARGET" && /B/.test(err.message),
  );
});

test("validateEdge: BLOCKS requires both ends to be resolvable (to is knowledge)", async () => {
  const state = makeState({ T: resolvableTask("T"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "T", to: "K", type: "BLOCKS" }, "cmd"),
    (err: TestError) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
  );
});

test("validateEdge: BLOCKS requires both ends to be resolvable (from is knowledge)", async () => {
  const state = makeState({ T: resolvableTask("T"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "K", to: "T", type: "BLOCKS" }, "cmd"),
    (err: TestError) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
  );
});

test("validateEdge: SUPERSEDES requires both ends to be the same kind (gate vs knowledge)", async () => {
  const state = makeState({ G: resolvableGate("G"), K: knowledgeNode("K") });
  assert.throws(
    () => validateEdge(state, { from: "G", to: "K", type: "SUPERSEDES" }, "cmd"),
    (err: TestError) => err.code === "INVALID_EDGE_KIND" && /SUPERSEDES/.test(err.message),
  );
});

test("validateEdge: SUPERSEDES between gates is accepted", async () => {
  const state = makeState({ G1: resolvableGate("G1"), G2: resolvableGate("G2") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "G1", to: "G2", type: "SUPERSEDES" }, "cmd"),
  );
});

test("validateEdge: SUPERSEDES between knowledge nodes is accepted", async () => {
  const state = makeState({ K1: knowledgeNode("K1"), K2: knowledgeNode("K2") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "K1", to: "K2", type: "SUPERSEDES" }, "cmd"),
  );
});

test("validateEdge: DERIVED_FROM has no extra kind rule", async () => {
  const state = makeState({ K: knowledgeNode("K"), T: resolvableTask("T") });
  assert.doesNotThrow(() =>
    validateEdge(state, { from: "K", to: "T", type: "DERIVED_FROM" }, "cmd"),
  );
});

test("validateEdge: rejects unknown edge types with code INVALID_EDGE_TYPE", async () => {
  const state = makeState({ T: resolvableTask("T"), G: resolvableGate("G") });
  for (const type of ["INFORMS", "RELATES_TO", "CONFLICTS_WITH"]) {
    assert.throws(
      () => validateEdge(state, { from: "T", to: "G", type }, "cmd"),
      (err: TestError) => err.code === "INVALID_EDGE_TYPE" && err.message.includes(type),
      `expected ${type} to be rejected with INVALID_EDGE_TYPE`,
    );
  }
});

test("validateEdge: missing target details carry the offending id", async () => {
  const state = makeState({ A: resolvableTask("A") });
  let caught: TestError | undefined;
  try {
    validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd");
  } catch (error) {
    caught = error as TestError;
  }
  assert.equal(caught?.code, "INVALID_EDGE_TARGET");
  assert.deepEqual(caught?.details, { missing: "B", from: "A", to: "B", type: "BLOCKS" });
});

test("validateEdge: commandName is reflected in error messages", async () => {
  const state = makeState({ T1: resolvableTask("T1") });
  assert.throws(
    () => validateEdge(state, { from: "T1", to: "T1", type: "BLOCKS" }, "my-command"),
    (err: TestError) => err.message.startsWith("my-command:"),
  );
});

test("validateEdge: handles missing state.nodes field defensively", async () => {
  assert.throws(
    () => validateEdge({ version: 1, edges: [], log: [] }, { from: "A", to: "B", type: "BLOCKS" }, "cmd"),
    (err: TestError) => err.code === "INVALID_EDGE_TARGET",
  );
});

test("validateEdge: BLOCKS direction is preserved (from=blocker, to=blocked)", async () => {
  const state = makeState({ A: resolvableTask("A"), B: resolvableGate("B") });
  assert.doesNotThrow(() => validateEdge(state, { from: "A", to: "B", type: "BLOCKS" }, "cmd"));
  assert.doesNotThrow(() => validateEdge(state, { from: "B", to: "A", type: "BLOCKS" }, "cmd"));
});

// --- add-edge: command integration -------------------------------------

test("add-edge: rejects self-edges with code SELF_EDGE", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await assert.rejects(
      addEdge({ statePath: dir, positional: ["T1", "T1"], flags: { type: "BLOCKS" } }),
      (err: TestError) => err.code === "SELF_EDGE",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects missing target nodes with code INVALID_EDGE_TARGET", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await assert.rejects(
      addEdge({ statePath: dir, positional: ["ghost", "also-ghost"], flags: { type: "BLOCKS" } }),
      (err: TestError) => err.code === "INVALID_EDGE_TARGET",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects BLOCKS targeting knowledge with code INVALID_EDGE_KIND", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
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
      (err: TestError) => err.code === "INVALID_EDGE_KIND" && /BLOCKS/.test(err.message),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects SUPERSEDES across kinds with code INVALID_EDGE_KIND", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
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
      (err: TestError) => err.code === "INVALID_EDGE_KIND" && /SUPERSEDES/.test(err.message),
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects duplicate (from, to, type) edges with code DUPLICATE_EDGE", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
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
      (err: TestError) => err.code === "DUPLICATE_EDGE",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: rejects INFORMS, RELATES_TO, CONFLICTS_WITH with code INVALID_EDGE_TYPE", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const { default: addEdge } = await importFresh("./cli/commands/add-edge.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
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
        (err: TestError) => err.code === "INVALID_EDGE_TYPE" && err.message.includes(type),
        `expected ${type} to be rejected with INVALID_EDGE_TYPE`,
      );
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --informs, --relates-to, --conflicts-with are no longer recognized flags", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "test" }, positional: ["auth"] });

    for (const flag of ["informs", "relates-to", "conflicts-with"]) {
      const r = await runCli([
        "--project", dir, "add-node", `Tx-${flag}`,
        "--kind", "resolvable", "--subkind", "task", "--title", `t-${flag}`,
        "--initiative", "auth",
        `--${flag}`, "G1",
      ]);
      assert.equal(r.code, 2, `expected --${flag} to fail, got ${r.stdout}`);
      const envelope = JSON.parse(r.stdout);
      assert.equal(envelope.error.code, "CLI_USAGE_ERROR");
      assert.equal(envelope.error.details.command, "add-node");
      assert.equal(envelope.error.details.flag, flag);
    }
  } finally {
    await rmTempProject(dir);
  }
});
