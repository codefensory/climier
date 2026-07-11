import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, stateFilePath, lockFilePath } from "./helpers.mjs";

test("storage: init uses global state path and leaves repo-local tasks.json absent", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const local = path.join(dir, ".agents", "tasks", "tasks.json");
    const localExists = await fs.access(local).then(() => true).catch(() => false);
    assert.equal(localExists, false);
    assert.equal(stateFilePath(dir).startsWith(path.join(process.env.CLIMIER_HOME, "projects")), true);
  } finally {
    await rmTempProject(dir);
  }
});

test("storage: project metadata makes sibling worktrees share the same state and lock path", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { updateState, readState } = await importFresh("./state.mjs");
  const a = await createTempProject();
  const b = await createTempProject();
  try {
    await init({ statePath: a, flags: {}, positional: [], projectDir: a });
    await fs.copyFile(path.join(a, ".climier.json"), path.join(b, ".climier.json"));

    assert.equal(stateFilePath(a), stateFilePath(b));
    assert.equal(lockFilePath(a), lockFilePath(b));

    await updateState(a, (s) => {
      s.tasks.T1 = { id: "T1", title: "shared" };
      return s;
    });
    const back = await readState(b);
    assert.equal(back.tasks.T1.title, "shared");
  } finally {
    await rmTempProject(a);
    await rmTempProject(b);
  }
});

test("storage: legacy repo-local tasks.json still works when project metadata is absent", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] }), "utf8");
    const s = await readState(dir);
    assert.equal(s.version, 1);
    assert.equal(stateFilePath(dir), file);
  } finally {
    await rmTempProject(dir);
  }
});
