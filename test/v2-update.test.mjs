// F6 — v2 update: field edits, revision tracking, --if-revision optimistic concurrency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState as readRawState, runCli } from "./helpers.mjs";

async function v2Project() {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const dir = await createTempProject();
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
  return dir;
}

async function seedTask(dir, id = "T-auth-1", extra = {}) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: "Implement session middleware",
      initiative: "auth",
      domain: "auth",
      tags: "backend,api",
      ...extra,
    },
  });
}

// --- revision initialization on creation ----------------------------------

test("add-node: initializes revision = 1 on a new v2 node", async () => {
  const dir = await v2Project();
  try {
    await seedTask(dir);
    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].revision, 1);
  } finally { await rmTempProject(dir); }
});

// --- happy path: field edits bump the revision --------------------------

test("update: changes title and bumps revision to 2", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    await seedTask(dir);
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { title: "Implement opaque session middleware", as: "alice" },
    });
    assert.equal(out.node.title, "Implement opaque session middleware");
    assert.equal(out.node.revision, 2);

    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].title, "Implement opaque session middleware");
    assert.equal(s.nodes["T-auth-1"].revision, 2);
  } finally { await rmTempProject(dir); }
});

test("update: parses --meta JSON and persists it", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    await seedTask(dir);
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { meta: '{"ticket":"AUTH-9001","severity":"high"}', as: "alice" },
    });
    assert.deepEqual(out.node.meta, { ticket: "AUTH-9001", severity: "high" });
    assert.equal(out.node.revision, 2);
  } finally { await rmTempProject(dir); }
});

test("update: parses --tags CSV and replaces the tag set", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    await seedTask(dir);
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { tags: "backend,api,critical", as: "alice" },
    });
    assert.deepEqual(out.node.tags, ["backend", "api", "critical"]);
  } finally { await rmTempProject(dir); }
});

test("update: bumps revision on every successful mutation", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    await seedTask(dir);
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "v2", as: "alice" } });
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "v3", as: "alice" } });
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "v4", as: "alice" } });
    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].title, "v4");
    assert.equal(s.nodes["T-auth-1"].revision, 4);
  } finally { await rmTempProject(dir); }
});

// --- --if-revision optimistic concurrency --------------------------------

test("update: --if-revision matching current revision applies and increments", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    await seedTask(dir);
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { title: "after CAS", "if-revision": 1, as: "alice" },
    });
    assert.equal(out.node.revision, 2);
    assert.equal(out.node.title, "after CAS");
  } finally { await rmTempProject(dir); }
});

test("update: --if-revision mismatch returns REVISION_CONFLICT with expected/current", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    await seedTask(dir);
    // First edit bumps revision 1 -> 2.
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "stale", as: "alice" } });
    // Caller still holds revision=1 in their head; should fail.
    let caught;
    try {
      await update({
        statePath: dir,
        positional: ["T-auth-1"],
        flags: { title: "too late", "if-revision": 1, as: "bob" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "REVISION_CONFLICT");
    assert.equal(caught.details.expected, 1);
    assert.equal(caught.details.current, 2);

    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].title, "stale");
    assert.equal(s.nodes["T-auth-1"].revision, 2);
  } finally { await rmTempProject(dir); }
});

test("update: without --if-revision a stale snapshot still mutates", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    await seedTask(dir);
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "first", as: "alice" } });
    // No --if-revision -> last-write-wins, no conflict.
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { title: "second", as: "bob" },
    });
    assert.equal(out.node.title, "second");
    assert.equal(out.node.revision, 3);
  } finally { await rmTempProject(dir); }
});

// --- error cases ---------------------------------------------------------

test("update: missing node returns NODE_NOT_FOUND", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await v2Project();
  try {
    let caught;
    try {
      await update({ statePath: dir, positional: ["ghost"], flags: { title: "x", as: "alice" } });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "NODE_NOT_FOUND");
    assert.equal(caught.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});

test("update: rejects update on a v1 state", async () => {
  const { default: update } = await importFresh("./commands/v2-update.mjs");
  const dir = await createTempProject();
  try {
    // Bootstrap a v1 state.
    const { writeState } = await importFresh("./state.mjs");
    await writeState(dir, {
      version: 1,
      tasks: { F0T1: { id: "F0T1", title: "v1 task", initiative: "x" } },
      decisions: {}, gotchas: {}, initiatives: { x: {} }, log: [],
    });
    let caught;
    try {
      await update({ statePath: dir, positional: ["F0T1"], flags: { title: "y", as: "alice" } });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.match(caught.message, /v1/i);
  } finally { await rmTempProject(dir); }
});

// --- CLI dispatch --------------------------------------------------------

test("CLI: v2 update emits REVISION_CONFLICT with structured details", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "test"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    // Bump revision to 2.
    r = await runCli(["--project", dir, "update", "T-auth-1", "--title", "v2", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.revision, 2);

    // Stale CAS.
    r = await runCli([
      "--project", dir, "update", "T-auth-1",
      "--title", "v3",
      "--if-revision", "1",
      "--as", "bob",
    ]);
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    assert.equal(err.error.code, "REVISION_CONFLICT");
    assert.equal(err.error.details.expected, 1);
    assert.equal(err.error.details.current, 2);
  } finally { await rmTempProject(dir); }
});

test("CLI: v2 update missing node emits NODE_NOT_FOUND", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "update", "ghost", "--title", "x", "--as", "alice"]);
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    assert.equal(err.error.code, "NODE_NOT_FOUND");
    assert.equal(err.error.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});