// TDD for ADR-022 piece 3: status --meta / --meta-keys opt-in projection.
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

async function addTask(dir, id, metaJson) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: id,
      initiative: "auth",
      ...(metaJson === undefined ? {} : { meta: metaJson }),
    },
  });
}

async function status(dir, flags) {
  const { default: statusCmd } = await importFresh("./cli/commands/status.mjs");
  return statusCmd({ statePath: dir, flags });
}

function allRows(result) {
  return [
    ...result.tasks.ready,
    ...result.tasks.in_progress,
    ...result.tasks.blocked,
    ...result.tasks.backlog,
    ...result.tasks.submitted,
  ];
}

test("status without meta flags keeps the legacy row shape (no meta key)", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-m-1", '{"pid":1,"space":"a"}');
    const result = await status(dir, {});
    for (const row of allRows(result)) {
      assert.equal("meta" in row, false);
    }
  } finally { await rmTempProject(dir); }
});

test("status --meta includes the full meta object", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-m-2", '{"pid":42,"space":"ws1"}');
    const result = await status(dir, { meta: true });
    const row = allRows(result).find((r) => r.id === "T-m-2");
    assert.ok(row);
    assert.deepEqual(row.meta, { pid: 42, space: "ws1" });
  } finally { await rmTempProject(dir); }
});

test("status --meta-keys projects only the requested keys", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-m-3", '{"pid":7,"space":"ws2","other":1}');
    const result = await status(dir, { "meta-keys": "pid" });
    const row = allRows(result).find((r) => r.id === "T-m-3");
    assert.ok(row);
    assert.deepEqual(row.meta, { pid: 7 });
  } finally { await rmTempProject(dir); }
});
