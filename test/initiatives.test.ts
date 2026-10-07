/* eslint-disable max-lines -- Initiative command tests stay together as a cohesive API contract file. */
// F3 — mandatory initiative for add-node + the initiative commands.
//
// Coverage:
//   - emptyState(2) includes `initiatives: {}`.
//   - writeState requires the `initiatives` collection.
//   - add-initiative: validate name, reject duplicates with ID_CONFLICT,
//     persist created_at.

//   - initiatives command handles a canonical state (node counts, --all).
//   - add-node: --initiative is mandatory (MISSING_FIELD).
//   - add-node: --initiative must be registered (INITIATIVE_NOT_FOUND),
//     unless --allow-unregistered-initiative is passed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, runCli, readState as readRawState, writeCanonicalState } from "./helpers.mjs";

type TestError = { code?: string; details?: Record<string, unknown> };

// --- pure helpers -------------------------------------------------------

function assertV2Error(data, code) {
  assert.equal(data.ok, false, "ok must be false");
  assert.ok(data.error && typeof data.error === "object", "error must be an object");
  assert.equal(data.error.code, code, `expected code ${code}, got ${data.error.code}`);
  assert.equal(typeof data.error.message, "string");
  assert.ok(data.error.details !== undefined);
}

// --- emptyState / writeState schema -------------------------------------

test("emptyState() seeds initiatives: {} on a fresh canonical state", async () => {
  const { emptyState } = await importFresh("./storage/state.ts");
  const s = emptyState();
  assert.equal(s.version, 1);
  assert.equal(s.revision, 0);
  assert.ok("initiatives" in s, "the state must declare initiatives");
  assert.deepEqual(s.initiatives, {});
  assert.ok("nodes" in s);
  assert.ok("edges" in s);
  assert.ok("log" in s);
});

test("writeState: rejects a state missing initiatives", async () => {
  const { writeState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      writeState(dir, { version: 2, nodes: {}, edges: [], log: [] }),
      /initiatives/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("writeState: accepts a state with empty initiatives", async () => {
  const { writeState, readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, { nodes: {}, edges: [], log: [], initiatives: {} });
    const back = await readState(dir);
    assert.deepEqual(back.initiatives, {});
  } finally {
    await rmTempProject(dir);
  }
});

// --- add-initiative: registration path ---------------------------------------------

test("add-initiative : registers a new initiative with desc and created_at", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    const out = await addInit({
      statePath: dir,
      flags: { desc: "auth swap plan" },
      positional: ["auth-migration"],
    });
    assert.equal(out.initiative.name, "auth-migration");
    assert.equal(out.initiative.desc, "auth swap plan");
    const s = await readState(dir);
    assert.equal(s.initiatives["auth-migration"].desc, "auth swap plan");
    assert.match(s.initiatives["auth-migration"].created_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-initiative : rejects duplicate name with ID_CONFLICT", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "first" }, positional: ["auth"] });
    await assert.rejects(
      addInit({ statePath: dir, flags: { desc: "second" }, positional: ["auth"] }),
      (err: TestError) => err.code === "ID_CONFLICT" && err.details && err.details.name === "auth",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-initiative : rejects bad name characters", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    for (const bad of ["has space", "with.dot", "with/slash", "with$dollar", ""]) {
      await assert.rejects(
        addInit({ statePath: dir, flags: { desc: "x" }, positional: [bad] }),
        /invalid|characters|required/i,
        `expected '${bad}' to be rejected`,
      );
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("add-initiative : missing name emits MISSING_FIELD", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await assert.rejects(
      addInit({ statePath: dir, flags: { desc: "x" }, positional: [] }),
      (err: TestError) => err.code === "MISSING_FIELD" && err.details && err.details.field === "name",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-initiative registers and emits a created_at envelope", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "auth swap"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.initiative.name, "auth");
    assert.equal(data.initiative.desc, "auth swap");
    assert.match(data.initiative.created_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-initiative duplicate emits ID_CONFLICT", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "x"]);
    assert.equal(r.code, 0);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "y"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "ID_CONFLICT");
    assert.equal(data.error.details.name, "auth");
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives : lists only initiatives with at least one live node by default", async () => {
  const { default: initiatives } = await importFresh("./cli/commands/initiatives.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "x" }, positional: ["a"] });
    await addInit({ statePath: dir, flags: { desc: "y" }, positional: ["b"] });
    await addNode({
      statePath: dir,
      positional: ["T1"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "t",
        initiative: "a",
      },
    });

    const out = await initiatives({ statePath: dir, flags: {} });
    const names = out.initiatives.map((i) => i.name);
    assert.deepEqual(names, ["a"], "default hides empty initiatives");
    assert.equal(out.initiatives[0].nodes, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives : --all surfaces every registered initiative, even empty ones", async () => {
  const { default: initiatives } = await importFresh("./cli/commands/initiatives.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["a"] });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["b"] });
    const out = await initiatives({ statePath: dir, flags: { all: true } });
    const names = out.initiatives.map((i) => i.name).toSorted();
    assert.deepEqual(names, ["a", "b"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("initiatives : counts both resolvable and knowledge nodes", async () => {
  const { default: initiatives } = await importFresh("./cli/commands/initiatives.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["a"] });
    await addNode({
      statePath: dir,
      positional: ["T1"],
      flags: { kind: "resolvable", subkind: "task", title: "t", initiative: "a" },
    });
    await addNode({
      statePath: dir,
      positional: ["T2"],
      flags: { kind: "resolvable", subkind: "task", title: "t2", initiative: "a" },
    });
    await addNode({
      statePath: dir,
      positional: ["K1"],
      flags: { kind: "knowledge", title: "k", initiative: "a" },
    });

    const out = await initiatives({ statePath: dir, flags: {} });
    const a = out.initiatives.find((i) => i.name === "a");
    assert.equal(a.nodes, 3);
    assert.equal(a.tasks, 2);
  } finally {
    await rmTempProject(dir);
  }
});

// --- add-node: mandatory initiative ------------------------------

test("add-node : missing --initiative emits MISSING_FIELD with field=initiative", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await assert.rejects(
      addNode({
        statePath: dir,
        positional: ["T1"],
        flags: { kind: "resolvable", subkind: "task", title: "t" },
      }),
      (err: TestError) => err.code === "MISSING_FIELD" && err.details && err.details.field === "initiative",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-node : unregistered initiative emits INITIATIVE_NOT_FOUND with details", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await assert.rejects(
      addNode({
        statePath: dir,
        positional: ["T1"],
        flags: {
          kind: "resolvable",
          subkind: "task",
          title: "t",
          initiative: "ghost",
        },
      }),
      (err: TestError) =>
        err.code === "INITIATIVE_NOT_FOUND" &&
        err.details &&
        err.details.initiative === "ghost" &&
        Array.isArray(err.details.existing),
    );
  } finally {
    await rmTempProject(dir);
  }
});

// test/internal-capabilities.test.mjs (which exercises
// addNodeInternal, the only sanctioned caller of the flag).

test("add-node : registered initiative is accepted with no INITIATIVE_NOT_FOUND", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["auth"] });
    const out = await addNode({
      statePath: dir,
      positional: ["T1"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "t",
        initiative: "auth",
      },
    });
    assert.equal(out.node.initiative, "auth");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-node : knowledge nodes also require --initiative", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await assert.rejects(
      addNode({
        statePath: dir,
        positional: ["K1"],
        flags: { kind: "knowledge", title: "k" },
      }),
      (err: TestError) => err.code === "MISSING_FIELD" && err.details && err.details.field === "initiative",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-node without --initiative emits MISSING_FIELD with initiative field", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0);
    r = await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
    ]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "MISSING_FIELD");
    assert.equal(data.error.details.field, "initiative");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-node with an unregistered initiative emits INITIATIVE_NOT_FOUND", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0);
    r = await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "ghost",
    ]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "INITIATIVE_NOT_FOUND");
    assert.equal(data.error.details.initiative, "ghost");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-node --initiative registered works end-to-end", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", ""]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.initiative, "auth");
  } finally {
    await rmTempProject(dir);
  }
});

// --- tests that pass --initiative without registering still pass
//     because the workflow pre-registered the initiative. This avoids an
//     unrelated test churn. Confirm explicitly:
test("existing test data with --initiative 'auth-migration' is fine if registered", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["auth-migration"] });
    await addNode({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "Implement session middleware",
        domain: "auth",
        initiative: "auth-migration",
      },
    });
    const state = await readRawState(dir);
    assert.equal(state.nodes["T-auth-1"].initiative, "auth-migration");
  } finally {
    await rmTempProject(dir);
  }
});
