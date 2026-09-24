// TDD for ADR-022 piece 8: release --reason is audited in the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState as readRawState,
} from "./helpers.mjs";

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

async function cmd(path, dir, positional, flags) {
  const { default: fn } = await importFresh(path);
  return fn({ statePath: dir, projectDir: dir, positional, flags });
}

function releaseEntries(log, id) {
  return (log || []).filter((e) => e.action === "release" && e.node === id);
}

test("release --reason records the reason in the log", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-r-1");
    await cmd("./cli/commands/take.mjs", dir, ["T-r-1"], { as: "alice" });
    const out = await cmd("./cli/commands/release.mjs", dir, ["T-r-1"], { as: "alice", reason: "process died" });
    assert.equal(out.released, true);
    assert.equal(out.node.claim, null);

    const state = await readRawState(dir);
    const entries = releaseEntries(state.log, "T-r-1");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, "process died");
  } finally { await rmTempProject(dir); }
});

test("release without --reason still works and logs no reason", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-r-2");
    await cmd("./cli/commands/take.mjs", dir, ["T-r-2"], { as: "alice" });
    const out = await cmd("./cli/commands/release.mjs", dir, ["T-r-2"], { as: "alice" });
    assert.equal(out.released, true);

    const state = await readRawState(dir);
    const entries = releaseEntries(state.log, "T-r-2");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, undefined);
  } finally { await rmTempProject(dir); }
});
