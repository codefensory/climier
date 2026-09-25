// init: create repo-local project metadata + global live state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, stateExists, stateFilePath, importFresh, runCli } from "./helpers.mjs";

test("init: creates empty v4 state file when none exists", async () => {
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
    assert.equal(s.version, 4);
    assert.equal(s.revision, 0);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
    assert.deepEqual(s.initiatives, {});
    assert.deepEqual(s.log, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("init: remote init preserves local sentinels and omits the server path", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const dir = await createTempProject();
  const metaPath = path.join(dir, ".climier.json");
  const meta = JSON.stringify({ project_id: "remote-project", backend: { type: "remote", url: "https://climier.example.test" } });
  const state = "local state sentinel";
  try {
    await fs.writeFile(metaPath, meta, "utf8");
    const file = stateFilePath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, state, "utf8");
    const result = await init({
      statePath: dir,
      projectDir: dir,
      projectConfig: JSON.parse(meta),
      backendClient: { type: "remote", async init() { return { seeded: null }; } },
    });
    assert.deepEqual(result, { ok: true, seeded: null, file: null });
    assert.equal(JSON.stringify(result).includes(file), false);
    assert.equal(await fs.readFile(metaPath, "utf8"), meta);
    assert.equal(await fs.readFile(file, "utf8"), state);
  } finally {
    await rmTempProject(dir);
  }
});

test("init: remote errors preserve local sentinels and force fails before filesystem access", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const dir = await createTempProject();
  const metaPath = path.join(dir, ".climier.json");
  const meta = JSON.stringify({ project_id: "remote-project", backend: { type: "remote", url: "https://climier.example.test" } });
  const state = "local state sentinel";
  try {
    await fs.writeFile(metaPath, meta, "utf8");
    const file = stateFilePath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, state, "utf8");
    const failures = [
      Object.assign(new Error("unauthorized"), { code: "AUTH_INVALID", status: 401 }),
      Object.assign(new Error("protocol mismatch"), { code: "PROTOCOL_VERSION_UNSUPPORTED" }),
      Object.assign(new Error("network unavailable"), { code: "REMOTE_REQUEST_FAILED" }),
    ];
    for (const failure of failures) {
      await assert.rejects(init({
        statePath: dir,
        projectDir: dir,
        projectConfig: JSON.parse(meta),
        backendClient: { type: "remote", async init() { throw failure; } },
      }), (error) => error === failure);
      assert.equal(await fs.readFile(metaPath, "utf8"), meta);
      assert.equal(await fs.readFile(file, "utf8"), state);
    }

    const untouched = path.join(dir, "not-created");
    await assert.rejects(init({
      statePath: untouched,
      projectDir: untouched,
      flags: { force: true },
      backendClient: { type: "remote", async init() { assert.fail("remote force must be rejected before request"); } },
    }), (error) => error.code === "REMOTE_UNSUPPORTED_OPERATION");
    await assert.rejects(fs.access(untouched), { code: "ENOENT" });
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

test("init: ignores unknown flags and still creates an empty v4 state", async () => {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { readState } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { seed: "migration" }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.equal(s.version, 4);
    assert.equal(s.revision, 0);
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

test("init: --force on an existing v1 state overwrites to empty v4", async () => {
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
    assert.equal(s.version, 4);
    assert.equal(s.revision, 0);
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
