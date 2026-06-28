// init: create an empty .agents/tasks/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, stateExists, runCli, importFresh } from "./helpers.mjs";

test("init: creates empty state file when none exists", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    assert.equal(await stateExists(dir), false);
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    assert.equal(await stateExists(dir), true);
  } finally {
    await rmTempProject(dir);
  }
});

test("init: fails if state already exists (no overwrite)", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    await assert.rejects(init({ statePath: dir, flags: {}, positional: [], projectDir: dir }));
  } finally {
    await rmTempProject(dir);
  }
});

test("init: --seed migration loads the migration preset", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { seed: "migration" }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.ok(s.initiatives.migration);
    assert.ok(s.tasks["F1.T1"]);
    assert.ok(s.decisions.D1);
    assert.ok(s.gotchas.G1);
  } finally {
    await rmTempProject(dir);
  }
});
