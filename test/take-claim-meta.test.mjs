// TDD for ADR-022 piece 1: `take --meta` writes claim.meta atomically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

async function v2Project() {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const dir = await createTempProject();
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
  return dir;
}

async function addTask(dir, id) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: { kind: "resolvable", subkind: "task", title: id, initiative: "auth" },
  });
}

async function take(dir, id, flags) {
  const { default: takeCmd } = await importFresh("./cli/commands/take.mjs");
  return takeCmd({ statePath: dir, flags, positional: [id], projectDir: dir });
}

async function show(dir, id) {
  const { default: showCmd } = await importFresh("./cli/commands/show.mjs");
  return showCmd({ statePath: dir, positional: [id] });
}

test("take --meta writes claim.meta in the same mutation (one revision)", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-meta-1");
    const before = await show(dir, "T-meta-1");
    assert.equal(before.node.revision, 1);

    const out = await take(dir, "T-meta-1", { as: "alice", meta: '{"pid":123}' });
    assert.deepEqual(out.node.claim, { by: "alice", at: out.node.claim.at, meta: { pid: 123 } });
    assert.equal(out.node.revision, 2);

    const after = await show(dir, "T-meta-1");
    assert.deepEqual(after.node.claim.meta, { pid: 123 });
    // node.meta untouched: claim.meta lives with the claim, not the node.
    assert.equal(after.node.meta, undefined);
  } finally { await rmTempProject(dir); }
});

test("take without --meta leaves claim without meta", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-meta-2");
    const out = await take(dir, "T-meta-2", { as: "alice" });
    assert.equal(out.node.claim.by, "alice");
    assert.equal(out.node.claim.meta, undefined);
  } finally { await rmTempProject(dir); }
});

test("take --meta rejects non-object JSON", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-meta-3");
    await assert.rejects(
      take(dir, "T-meta-3", { as: "alice", meta: "[1,2]" }),
      (err) => /--meta must be a JSON object/.test(err.message),
    );
  } finally { await rmTempProject(dir); }
});

test("take --meta rejects invalid JSON", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-meta-4");
    await assert.rejects(
      take(dir, "T-meta-4", { as: "alice", meta: "{bad" }),
      (err) => /--meta must be valid JSON/.test(err.message),
    );
  } finally { await rmTempProject(dir); }
});
