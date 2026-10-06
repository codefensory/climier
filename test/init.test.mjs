// init: create repo-local project metadata + global live state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, stateExists, stateFilePath, importFresh, runCli } from "./helpers.mjs";
import { runCli as runCliInProcess } from "../src/cli/dispatch.ts";

test("init: creates empty canonical v1 state and ledger when none exists", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const dir = await createTempProject();
  try {
    assert.equal(await stateExists(dir), false);
    const result = await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    assert.deepEqual(result, { ok: true, seeded: null, file: stateFilePath(dir) });
    assert.equal(await stateExists(dir), true);
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8"));
    assert.match(meta.project_id, /\S/);
    assert.equal(stateFilePath(dir).startsWith(path.join(process.env.CLIMIER_HOME, "projects")), true);
    const { readState } = await importFresh("./storage/state.ts");
    const s = await readState(dir);
    assert.equal(s.version, 1);
    assert.equal(s.fence_generation, 1);
    assert.equal(s.revision, 1);
    const ledgerPath = path.join(path.dirname(stateFilePath(dir)), "revision-ledger.json");
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.equal(ledger.high_water_revision, s.revision);
    assert.equal(Object.hasOwn(ledger, "migration_pending"), false);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
    assert.deepEqual(s.initiatives, {});
    assert.deepEqual(s.log, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("init: remote init preserves local sentinels and omits the server path", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
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

test("init: insecure remote HTTP returns a warning after successful provisioning", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const dir = await createTempProject();
  let requests = 0;
  try {
    const result = await init({
      statePath: dir,
      projectDir: dir,
      projectConfig: { backend: { type: "remote", url: "http://remote.example.test:43127/path" } },
      backendClient: {
        type: "remote",
        insecureRemoteHttp: true,
        async init() { requests += 1; return { seeded: null }; },
      },
    });
    assert.equal(requests, 1);
    assert.deepEqual(result, {
      ok: true,
      seeded: null,
      file: null,
      warnings: [{
        kind: "insecure-remote-http",
        severity: "warning",
        message: "init: http://remote.example.test:43127 is not HTTPS; the login password and bearer travel without transport encryption.",
      }],
    });
  } finally {
    await rmTempProject(dir);
  }
});

async function runInsecureRemoteInit(dir, client, args = ["init"]) {
  const output = [];
  const errors = [];
  const status = await runCliInProcess({
    argv: ["--project", dir, ...args],
    createBackendClient: () => client,
    write: (value) => output.push(value),
    exit: (code) => errors.push(code),
  });
  return { status, output, errors };
}

test("CLI: insecure remote HTTP init returns the warning in its JSON envelope", async () => {
  const dir = await createTempProject();
  try {
    await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
      project_id: "remote-project",
      backend: { type: "remote", url: "http://internal.example.test" },
    }));
    const result = await runInsecureRemoteInit(dir, {
      type: "remote",
      insecureRemoteHttp: true,
      async init() { return { seeded: null }; },
    });
    assert.equal(result.status, 0);
    assert.equal(result.output.length, 1);
    assert.deepEqual(JSON.parse(result.output[0]).warnings, [{
      kind: "insecure-remote-http",
      severity: "warning",
      message: "init: http://internal.example.test is not HTTPS; the login password and bearer travel without transport encryption.",
    }]);
    assert.deepEqual(result.errors, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: init --no-warnings works before and after the command", async () => {
  for (const args of [["--no-warnings", "init"], ["init", "--no-warnings"]]) {
    const dir = await createTempProject();
    try {
      await fs.writeFile(path.join(dir, ".climier.json"), JSON.stringify({
        project_id: "remote-project",
        backend: { type: "remote", url: "http://internal.example.test" },
      }));
      const result = await runInsecureRemoteInit(dir, {
        type: "remote",
        insecureRemoteHttp: true,
        async init() { return { seeded: null }; },
      }, args);
      assert.equal(result.status, 0);
      assert.equal(Object.hasOwn(JSON.parse(result.output[0]), "warnings"), false);
    } finally {
      await rmTempProject(dir);
    }
  }
});

test("init: HTTPS and loopback remote init omit warnings", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const dir = await createTempProject();
  try {
    for (const url of ["https://remote.example.test/path", "http://localhost:43127/path", "http://127.0.0.1:43127/path"]) {
      const result = await init({
        statePath: dir,
        projectDir: dir,
        projectConfig: { backend: { type: "remote", url } },
        backendClient: {
          type: "remote",
          insecureRemoteHttp: url.startsWith("http://") && !url.includes("localhost") && !url.includes("127.0.0.1"),
          async init() { return { seeded: null }; },
        },
      });
      assert.deepEqual(result, { ok: true, seeded: null, file: null });
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("init: remote errors preserve local sentinels and force fails before filesystem access", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
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
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    await assert.rejects(init({ statePath: dir, flags: {}, positional: [], projectDir: dir }));
  } finally {
    await rmTempProject(dir);
  }
});

test("init: ignores unknown flags and still creates an empty canonical v1 state", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { seed: "migration" }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.equal(s.version, 1);
    assert.equal(s.fence_generation, 1);
    assert.equal(s.revision, 1);
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("init: refuses to overwrite an existing valid state without --force", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const file = stateFilePath(dir);
    const before = await fs.readFile(file, "utf8");

    let caught;
    try {
      await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    } catch (e) { caught = e; }
    assert.ok(caught, "init without --force on a valid existing state must throw");
    assert.match(caught.message, /already exists/i);
    assert.match(caught.message, /--force/);
    assert.equal(await fs.readFile(file, "utf8"), before, "existing state must remain unchanged");
  } finally { await rmTempProject(dir); }
});

test("init: --force replaces an existing canonical v1 state and preserves ledger high-water", async () => {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const file = stateFilePath(dir);
    await fs.writeFile(file, JSON.stringify({
      version: 1, fence_generation: 1, revision: 0, nodes: { T1: { id: "T1", title: "v1" } },
      edges: [], initiatives: {}, log: [],
    }), "utf8");

    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.equal(s.version, 1);
    assert.equal(s.fence_generation, 1);
    const ledgerPath = path.join(path.dirname(file), "revision-ledger.json");
    const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    assert.equal(s.revision, ledger.high_water_revision);
    assert.ok(s.revision > 1, "force-init must not lower an existing ledger high-water");
    assert.deepEqual(s.nodes, {});
    assert.deepEqual(s.edges, []);
  } finally { await rmTempProject(dir); }
});

test("CLI: init rejects --v2 flag", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 2, `expected exit 2; got ${r.code}: ${r.stdout}`);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "CLI_USAGE_ERROR");
    assert.equal(data.error.details.command, "init");
    assert.equal(data.error.details.flag, "v2");
  } finally { await rmTempProject(dir); }
});
