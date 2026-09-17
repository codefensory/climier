// TDD for ADR-022 piece 4: status --mine narrows to the caller's claims.
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

async function status(dir, flags) {
  const { default: statusCmd } = await importFresh("./cli/commands/status.mjs");
  return statusCmd({ statePath: dir, flags });
}

test("status --mine shows only the caller's in_progress (via --as)", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-mine-1");
    await addTask(dir, "T-mine-2");
    await take(dir, "T-mine-1", { as: "alice" });
    await take(dir, "T-mine-2", { as: "bob" });

    const mine = await status(dir, { mine: true, as: "alice" });
    assert.deepEqual(mine.tasks.in_progress.map((t) => t.id), ["T-mine-1"]);

    const all = await status(dir, { as: "alice" });
    assert.equal(all.tasks.in_progress.length, 2);
  } finally { await rmTempProject(dir); }
});

test("status --mine without identity throws a clear error", async () => {
  const dir = await v2Project();
  const saved = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  try {
    await assert.rejects(
      status(dir, { mine: true }),
      (err) => /--mine requires --as/.test(err.message),
    );
  } finally {
    if (saved !== undefined) process.env.CLIMIER_AGENT = saved;
    await rmTempProject(dir);
  }
});
