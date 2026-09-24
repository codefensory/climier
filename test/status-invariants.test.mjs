// TDD for ADR-022 piece 9: state invariants surface in status alerts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState as readRawState,
  writeState as writeRawState,
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

async function status(dir, flags) {
  const { default: statusCmd } = await importFresh("./cli/commands/status.mjs");
  return statusCmd({ statePath: dir, flags });
}

test("in_progress without a claim surfaces a state-invariant alert", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-i-1");
    const state = await readRawState(dir);
    state.nodes["T-i-1"].status = "in_progress";
    state.nodes["T-i-1"].claim = null;
    await writeRawState(dir, state);

    const out = await status(dir, {});
    const hit = out.alerts.find((a) => a.task_id === "T-i-1" && a.kind === "state-invariant");
    assert.ok(hit, "expected a state-invariant alert for claimless in_progress");
    assert.equal(hit.severity, "error");
  } finally { await rmTempProject(dir); }
});

test("done without done_by surfaces a state-invariant alert", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-i-2");
    const state = await readRawState(dir);
    state.nodes["T-i-2"].status = "done";
    delete state.nodes["T-i-2"].done_by;
    await writeRawState(dir, state);

    const out = await status(dir, {});
    const hit = out.alerts.find((a) => a.task_id === "T-i-2" && a.kind === "state-invariant");
    assert.ok(hit, "expected a state-invariant alert for done without done_by");
    assert.equal(hit.severity, "error");
  } finally { await rmTempProject(dir); }
});

test("done tasks with completion metadata do not produce a state-invariant alert", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-i-done");
    const state = await readRawState(dir);
    state.nodes["T-i-done"].status = "done";
    state.nodes["T-i-done"].done_by = "alice";
    state.nodes["T-i-done"].done_at = "2026-01-02T03:04:05.000Z";
    await writeRawState(dir, state);

    const out = await status(dir, {});
    assert.ok(!out.alerts.some((a) => a.task_id === "T-i-done" && a.check === "missing-done-by"));
  } finally { await rmTempProject(dir); }
});

test("healthy tasks produce no state-invariant alerts", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-i-3");
    const out = await status(dir, {});
    assert.ok(!out.alerts.some((a) => a.kind === "state-invariant"));
  } finally { await rmTempProject(dir); }
});
