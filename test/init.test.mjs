// init: create repo-local project metadata + global live state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, stateExists, stateFilePath, importFresh } from "./helpers.mjs";

test("init: creates empty state file when none exists", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    assert.equal(await stateExists(dir), false);
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    assert.equal(await stateExists(dir), true);
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8"));
    assert.match(meta.project_id, /\S/);
    assert.equal(stateFilePath(dir).startsWith(path.join(process.env.CLIMIER_HOME, "projects")), true);
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

test("init: ignores old seed flags and still creates an empty state", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { seed: "migration" }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.deepEqual(s.tasks, {});
    assert.deepEqual(s.decisions, {});
    assert.deepEqual(s.gotchas, {});
  } finally {
    await rmTempProject(dir);
  }
});
