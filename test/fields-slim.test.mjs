// TDD for ADR-022 piece 5: --fields / --slim trim show and status output.
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
    flags: { kind: "resolvable", subkind: "task", title: `title-${id}`, initiative: "auth" },
  });
}

async function show(dir, id, flags = {}) {
  const { default: showCmd } = await importFresh("./cli/commands/show.mjs");
  return showCmd({ statePath: dir, positional: [id], flags });
}

async function status(dir, flags) {
  const { default: statusCmd } = await importFresh("./cli/commands/status.mjs");
  return statusCmd({ statePath: dir, flags });
}

test("show --fields projects only the requested node keys", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-f-1");
    const out = await show(dir, "T-f-1", { fields: "id,title,status" });
    assert.equal(out.type, "task");
    assert.deepEqual(Object.keys(out.node).sort(), ["id", "status", "title"]);
    assert.equal(out.node.title, "title-T-f-1");
  } finally { await rmTempProject(dir); }
});

test("show --slim returns the minimal node shape", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-f-2");
    const out = await show(dir, "T-f-2", { slim: true });
    assert.equal(out.type, "task");
    for (const key of ["id", "title", "status"]) assert.ok(key in out.node, `missing ${key}`);
    assert.ok(!("body" in out.node), "slim must drop body");
  } finally { await rmTempProject(dir); }
});

test("status --slim trims rows to the minimal shape", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-f-3");
    const out = await status(dir, { slim: true });
    const row = [...out.tasks.ready, ...out.tasks.blocked].find((r) => r.id === "T-f-3");
    assert.ok(row);
    assert.ok(!("domain" in row), "slim must drop domain");
    assert.ok("id" in row && "title" in row && "status" in row);
  } finally { await rmTempProject(dir); }
});

test("status --fields projects rows to the requested keys", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-f-4");
    const out = await status(dir, { fields: "id,status" });
    const row = [...out.tasks.ready, ...out.tasks.blocked].find((r) => r.id === "T-f-4");
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), ["id", "status"]);
  } finally { await rmTempProject(dir); }
});
