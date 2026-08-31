// init: create repo-local project metadata + global live state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, stateExists, stateFilePath, importFresh, runCli } from "./helpers.mjs";

test("init: creates empty v2 state file when none exists", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const dir = await createTempProject();
  try {
    assert.equal(await stateExists(dir), false);
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    assert.equal(await stateExists(dir), true);
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8"));
    assert.match(meta.project_id, /\S/);
    assert.equal(stateFilePath(dir).startsWith(path.join(process.env.CLIMIER_HOME, "projects")), true);
    const { readState } = await importFresh("./storage/state.mjs");
    const s = await readState(dir);
    assert.equal(s.version, 2);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
    assert.deepEqual(s.initiatives, {});
    assert.deepEqual(s.log, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("init: fails if state already exists (no overwrite)", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    await assert.rejects(init({ statePath: dir, flags: {}, positional: [], projectDir: dir }));
  } finally {
    await rmTempProject(dir);
  }
});

test("init: ignores unknown flags and still creates an empty v2 state", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { readState } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { seed: "migration" }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.equal(s.version, 2);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
  } finally {
    await rmTempProject(dir);
  }
});

// === v1-unsupported init behavior =========================================

test("init: refuses on an existing v1 state without --force and mentions --force", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const dir = await createTempProject();
  try {
    // Bootstrap .climier.json so stateFile() resolves to a real path.
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    // Overwrite the state file with a v1 shape (bypassing writeState).
    const file = stateFilePath(dir);
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1", title: "v1" } },
      decisions: {}, gotchas: {}, initiatives: {}, log: [],
    }), "utf8");

    let caught;
    try {
      await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    } catch (e) { caught = e; }
    assert.ok(caught, "init without --force on v1 must throw");
    assert.equal(caught.code, "STATE_V1_UNSUPPORTED");
    assert.match(caught.message, /--force/);
    assert.match(caught.message, /v1/i);
    // The v1 file must NOT be overwritten.
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(raw.version, 1, "v1 state must remain on disk without --force");
  } finally { await rmTempProject(dir); }
});

test("init: --force on an existing v1 state overwrites to empty v2", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { readState } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const file = stateFilePath(dir);
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1", title: "v1" } },
      decisions: {}, gotchas: {}, initiatives: {}, log: [],
    }), "utf8");

    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.equal(s.version, 2);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
  } finally { await rmTempProject(dir); }
});

test("CLI: init rejects --v2 flag", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 1, `expected exit 1; got ${r.code}: ${r.stdout}`);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown flag --v2/);
  } finally { await rmTempProject(dir); }
});
