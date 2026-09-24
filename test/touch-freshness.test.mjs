// TDD for ADR-022 piece 7: --stale-ms uses claim.heartbeat_at ?? claim.at.
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

async function cmd(path, dir, positional, flags) {
  const { default: fn } = await importFresh(path);
  return fn({ statePath: dir, projectDir: dir, positional, flags });
}

const HOUR = 60 * 60 * 1000;

test("stale-ms uses heartbeat_at when present (touch clears a stale alert)", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-s-1");
    await cmd("./cli/commands/take.mjs", dir, ["T-s-1"], { as: "alice" });

    // Backdate the claim so it looks stale.
    const state = await readRawState(dir);
    state.nodes["T-s-1"].claim.at = new Date(Date.now() - 5 * HOUR).toISOString();
    await writeRawState(dir, state);

    const stale = await cmd("./cli/commands/status.mjs", dir, [], { "stale-ms": String(HOUR) });
    assert.ok(stale.alerts.some((a) => a.kind === "stale-claim" && a.task_id === "T-s-1"));

    await cmd("./cli/commands/touch.mjs", dir, ["T-s-1"], { as: "alice" });
    const fresh = await cmd("./cli/commands/status.mjs", dir, [], { "stale-ms": String(HOUR) });
    assert.ok(!fresh.alerts.some((a) => a.kind === "stale-claim" && a.task_id === "T-s-1"));
  } finally { await rmTempProject(dir); }
});

test("stale-ms falls back to claim.at when no heartbeat exists", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-s-2");
    await cmd("./cli/commands/take.mjs", dir, ["T-s-2"], { as: "alice" });

    const state = await readRawState(dir);
    state.nodes["T-s-2"].claim.at = new Date(Date.now() - 5 * HOUR).toISOString();
    delete state.nodes["T-s-2"].claim.heartbeat_at;
    await writeRawState(dir, state);

    const out = await cmd("./cli/commands/status.mjs", dir, [], { "stale-ms": String(HOUR) });
    assert.ok(out.alerts.some((a) => a.kind === "stale-claim" && a.task_id === "T-s-2"));
  } finally { await rmTempProject(dir); }
});
