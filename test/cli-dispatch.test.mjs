// CLI dispatch: each command runs end-to-end via the real bin.
// All output is JSON to stdout. All errors are JSON to stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempProject, rmTempProject, runCli, initExampleProject, installPolicyFixture, uninstallPolicyFixture } from "./helpers.mjs";
import { dispatchCommand, runCli as runCliInProcess } from "../src/cli/dispatch.mjs";

const packageVersion = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
).version;

test("CLI: init then status", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(data.summary);
    assert.ok(data.tasks);
    assert.ok(Array.isArray(data.tasks.ready));
    assert.ok(Array.isArray(data.tasks.in_progress));
    assert.ok(Array.isArray(data.tasks.blocked));
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: init example fixture then status lists claimable tasks", async () => {
  const dir = await createTempProject();
  try {
    let r = await initExampleProject(dir);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    const readyIds = data.tasks.ready.map((t) => t.id);
    assert.ok(readyIds.includes("F0.T1"));
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: take fails without --as", async () => {
  const dir = await createTempProject();
  try {
    let r = await initExampleProject(dir);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "take", "F0.T1"], { env: { CLIMIER_AGENT: "" } });
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error.message || data.error, /--as/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: take, submit and accept --as work", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    // F0.T1 has no deps; claimable directly.
    const c = await runCli(["--project", dir, "take", "F0.T1", "--as", "agent-1"]);
    assert.equal(c.code, 0, c.stderr);
    const cdata = JSON.parse(c.stdout);
    assert.equal(cdata.node.id, "F0.T1");
    let d = await runCli(["--project", dir, "submit", "F0.T1", "--note", "shipped", "--as", "agent-1"]);
    assert.equal(d.code, 0, d.stderr);
    d = await runCli(["--project", dir, "accept", "F0.T1", "--as", "validator"]);
    assert.equal(d.code, 0, d.stderr);
    const ddata = JSON.parse(d.stdout);
    assert.equal(ddata.node.status, "done");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: reopen --as policy-allow actor rolls back a done task end-to-end", async () => {
  // ADR-008 §"`task.reopen`" exercises the seam allow path via the
  // policy-fixture: under ADR-009 the core itself accepts any actor,
  // so this case pins the policy allow behavior explicitly. Without
  // the fixture the same reopen would also succeed (default core).
  const dir = await createTempProject();
  await installPolicyFixture(dir);
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "take", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "submit", "F0.T1", "--note", "shipped", "--as", "agent-1"]);
    await runCli(["--project", dir, "accept", "F0.T1", "--as", "validator"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "--reason", "le falta validacion", "--as", "auditor",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id, "F0.T1");
    assert.equal(data.node.status, "open");

    // F0.T2 (depends on F0.T1) should be blocked again, not ready.
    const s = await runCli(["--project", dir, "status"]);
    assert.equal(s.code, 0, s.stderr);
    const sdata = JSON.parse(s.stdout);
    const blockedIds = (sdata.tasks.blocked || []).map((t) => t.id);
    assert.equal(blockedIds.includes("F0.T2"), true, "F0.T2 should be blocked after reopen");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});

test("CLI: reopen by a stranger succeeds under ADR-009 (no ownership compare on done_by)", async () => {
  // ADR-009 §"Resto de operaciones": reopen may roll back any terminal
  // resolvable from any actor; the core only checks state validity and
  // required fields. State validation and required-field enforcement
  // are still verified separately (see the next two tests).
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "take", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "submit", "F0.T1", "--note", "shipped", "--as", "agent-1"]);
    await runCli(["--project", dir, "accept", "F0.T1", "--as", "validator"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "--reason", "I want to", "--as", "agent-2",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id, "F0.T1");
    assert.equal(data.node.status, "open");
    assert.equal(data.node.done_by, undefined, "done_by cleared on reopen");
    assert.equal(data.node.done_at, undefined, "done_at cleared on reopen");
    assert.equal(data.node.note, undefined, "note cleared on reopen");
    assert.equal(data.node.claim, null, "claim cleared on reopen");

    // F0.T2 (depends on F0.T1) must be blocked again.
    const s = await runCli(["--project", dir, "status"]);
    assert.equal(s.code, 0, s.stderr);
    const sdata = JSON.parse(s.stdout);
    const blockedIds = (sdata.tasks.blocked || []).map((t) => t.id);
    assert.equal(blockedIds.includes("F0.T2"), true, "F0.T2 should be blocked after reopen");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: reopen without --reason still fails with MISSING_FIELD (required field is enforced)", async () => {
  // ADR-009 §"Resto de operaciones": state validation and required fields
  // are part of the core contract; only ownership checks were removed.
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "take", "F0.T1", "--as", "agent-1"]);
    await runCli(["--project", dir, "submit", "F0.T1", "--note", "shipped", "--as", "agent-1"]);
    await runCli(["--project", dir, "accept", "F0.T1", "--as", "validator"]);

    const r = await runCli([
      "--project", dir, "reopen", "F0.T1", "--as", "agent-2",
    ]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error.message || data.error, /--reason/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: context on a ready task reports derived_status=ready and no blocking", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "context", "F0.T1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id, "F0.T1");
    assert.equal(data.derived_status, "ready");
    assert.equal(data.can_claim, true);
    assert.equal(data.blocking.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-gate creates an open gate (replaces v1 add-decision)", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "add-gate", "D9", "--initiative", "migration", "--title", "investigar X", "--body", "que pasa con auth?", "--purpose", "decision"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.id, "D9");
    assert.equal(data.node.subkind, "gate");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-gate fails without --title", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "add-gate", "D9", "--initiative", "migration", "--body", "x", "--purpose", "decision"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error.message || data.error, /--title required/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --help prints help and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "--help"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /climier/i);
    assert.match(r.stdout, /take/);
    assert.match(r.stdout, /context/);
    assert.match(r.stdout, /add-gate/);
    assert.doesNotMatch(r.stdout, /\.agents\/skills/i);
    assert.doesNotMatch(r.stdout, /example fixture/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: -h prints help and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "-h"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /climier/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: help command prints help and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "help"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /take/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --version prints the package version and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "--version"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), packageVersion);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: version command prints the package version and exits 0", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "version"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), packageVersion);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: context on a missing task exits non-zero with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "context", "NOPE"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error.message || data.error, /not found/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: unknown command exits non-zero with JSON error", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "nosuchcmd"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /unknown command/);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: update a task via the bin (edit title + body)", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    const seed = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "old title", "--body", "old body", "--acceptance", "a", "--blocked-by", ""]);
    assert.equal(seed.code, 0, seed.stderr);
    const seedId = JSON.parse(seed.stdout).node.id;

    r = await runCli(["--project", dir, "update", seedId, "--title", "new title", "--body", "## Spec\n\nDetails here", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.title, "new title");
    assert.equal(data.node.body, "## Spec\n\nDetails here");
    // verify it persisted
    r = await runCli(["--project", dir, "show", seedId]);
    const shown = JSON.parse(r.stdout);
    assert.equal(shown.node.title, "new title");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: add-note appends to the thread", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    const seed = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "x", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
    assert.equal(seed.code, 0, seed.stderr);
    const seedId = JSON.parse(seed.stdout).node.id;

    r = await runCli(["--project", dir, "add-note", seedId, "first note", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-note", seedId, "second note", "--as", "bob"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "show", seedId]);
    const shown = JSON.parse(r.stdout);
    assert.equal(shown.node.notes.length, 2);
    assert.deepEqual(shown.node.notes.map((n) => n.text), ["first note", "second note"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: update on an in_progress task is allowed (v2 contract: no claim lock)", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    const seed = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "x", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
    assert.equal(seed.code, 0, seed.stderr);
    const seedId = JSON.parse(seed.stdout).node.id;
    // take so it's in_progress
    r = await runCli(["--project", dir, "take", seedId, "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    // v2 update is allowed on in_progress tasks (no claim lock).
    r = await runCli(["--project", dir, "update", seedId, "--title", "edited while in progress", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.title, "edited while in progress");
    assert.equal(data.node.status, "in_progress");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: resolve on a ready task is rejected without mutation", async () => {
  // Tasks must use take → submit → accept; resolve is reserved for gates.
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    const seed = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "x", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
    assert.equal(seed.code, 0, seed.stderr);
    const seedId = JSON.parse(seed.stdout).node.id;

    r = await runCli(["--project", dir, "resolve", seedId, "--note", "resolved from ready", "--as", "alice"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "INVALID_EXECUTION_CONTRACT");
    const state = JSON.parse((await runCli(["--project", dir, "show", seedId])).stdout);
    assert.equal(state.node.status, "open");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: resolve without --note still rejects a task as an unsupported target", async () => {
  // The task resolve bypass was removed; --note is not a task lifecycle input.
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    const seed = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "x", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
    assert.equal(seed.code, 0, seed.stderr);
    const seedId = JSON.parse(seed.stdout).node.id;

    r = await runCli(["--project", dir, "resolve", seedId, "--as", "alice"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "INVALID_EXECUTION_CONTRACT");
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: resolve without --as fails with JSON error", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "migration", "--desc", "x"]);
    assert.equal(r.code, 0, r.stderr);
    const seed = await runCli(["--project", dir, "add-task", "--initiative", "migration", "--title", "x", "--body", "b", "--acceptance", "a", "--blocked-by", ""]);
    assert.equal(seed.code, 0, seed.stderr);
    const seedId = JSON.parse(seed.stdout).node.id;
    await runCli(["--project", dir, "take", seedId, "--as", "alice"]);
    r = await runCli(["--project", dir, "resolve", seedId, "--note", "missing --as"], { env: { CLIMIER_AGENT: "" } });
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error.message || data.error, /--as/);
  } finally {
    await rmTempProject(dir);
  }
});

test("dispatch: absent or local project config selects the local backend without state I/O", async () => {
  for (const metadata of [null, { version: 1, project_id: "local-project", backend: { type: "local" } }]) {
    const dir = await createTempProject();
    try {
      if (metadata) fs.writeFileSync(path.join(dir, ".climier.json"), JSON.stringify(metadata));
      let received;
      const result = await runCliInProcess({
        argv: ["--project", dir, "status", "--as", "alice"],
        write() {},
        exit() {},
        dispatch: async (context) => {
          received = context;
          return { ok: true };
        },
      });
      assert.equal(result, 0);
      assert.equal(received.projectDir, dir);
      assert.deepEqual(received.projectConfig, metadata || {});
      assert.equal(received.backendClient.type, "local");
      assert.equal(received.flags.as, "alice");
      assert.equal(fs.existsSync(path.join(dir, ".climier.json")), Boolean(metadata));
    } finally {
      await rmTempProject(dir);
    }
  }
});

test("dispatch: help and no-command handling remain ahead of backend selection", async () => {
  const dir = await createTempProject();
  try {
    fs.writeFileSync(path.join(dir, ".climier.json"), "{invalid json");
    const helpOutput = [];
    const helpCodes = [];
    const helpResult = await runCliInProcess({
      argv: ["--project", dir, "--help"],
      createBackendClient() { throw new Error("help must not select a backend"); },
      write: (value) => helpOutput.push(value),
      exit: (code) => helpCodes.push(code),
    });
    assert.equal(helpResult, 0);
    assert.deepEqual(helpCodes, [0]);
    assert.match(helpOutput[0], /climier/i);

    const noCommandOutput = [];
    const noCommandCodes = [];
    const noCommandResult = await runCliInProcess({
      argv: ["--project", dir],
      createBackendClient() { throw new Error("no-command handling must not select a backend"); },
      write: (value) => noCommandOutput.push(value),
      exit: (code) => noCommandCodes.push(code),
    });
    assert.equal(noCommandResult, 2);
    assert.deepEqual(noCommandCodes, [2]);
    assert.match(JSON.parse(noCommandOutput[0]).error, /no command given/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("dispatch: remote project config and injected client reach command dispatch with source intact", async () => {
  const dir = await createTempProject();
  try {
    const projectConfig = {
      version: 1,
      project_id: "remote/project",
      backend: { type: "remote", url: "https://climier.example.test" },
    };
    fs.writeFileSync(path.join(dir, ".climier.json"), JSON.stringify(projectConfig));
    const localCalls = [];
    const source = {
      registry: { lookup(...args) { localCalls.push(["lookup", ...args]); } },
      mutate(...args) { localCalls.push(["mutate", ...args]); },
    };
    const client = { type: "remote", marker: "injected" };
    let factoryOptions;
    let dispatched;
    const result = await runCliInProcess({
      argv: ["--project", dir, "take", "T1", "--as", "alice"],
      source,
      createBackendClient(options) {
        factoryOptions = options;
        return client;
      },
      dispatch: async (context) => {
        dispatched = context;
        return { ok: true };
      },
      write() {},
      exit() {},
    });
    assert.equal(result, 0);
    assert.equal(factoryOptions.projectDir, dir);
    assert.deepEqual(factoryOptions.projectConfig, projectConfig);
    assert.equal(factoryOptions.source, source);
    assert.equal(dispatched.backendClient, client);
    assert.deepEqual(dispatched.projectConfig, projectConfig);
    assert.equal(dispatched.flags.as, "alice");
    assert.deepEqual(dispatched.positional, ["T1"]);
    assert.deepEqual(localCalls, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("dispatch: invalid project metadata fails before command dispatch", async () => {
  const dir = await createTempProject();
  try {
    fs.writeFileSync(path.join(dir, ".climier.json"), "{invalid json");
    let dispatched = false;
    const output = [];
    const codes = [];
    const result = await runCliInProcess({
      argv: ["--project", dir, "status"],
      dispatch: async () => { dispatched = true; },
      write: (value) => output.push(value),
      exit: (code) => codes.push(code),
    });
    assert.equal(result, 1);
    assert.deepEqual(codes, [1]);
    assert.equal(dispatched, false);
    const payload = JSON.parse(output[0]);
    assert.equal(payload.error.code, "STORAGE_ERROR");
    assert.equal(payload.error.details.cause, "CLIMIER_CORRUPT_PROJECT_META");
  } finally {
    await rmTempProject(dir);
  }
});

test("dispatch: remote unsupported operation is denied before plugin loading", async () => {
  const dir = await createTempProject();
  const previousHome = process.env.CLIMIER_HOME;
  const pluginHome = fs.mkdtempSync(path.join(path.dirname(dir), "climier-remote-plugin-home-"));
  try {
    process.env.CLIMIER_HOME = pluginHome;
    const installed = path.join(pluginHome, "plugins", "installed", "audit");
    fs.mkdirSync(installed, { recursive: true });
    const marker = path.join(pluginHome, "loaded");
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({
      name: "audit",
      version: "1.0.0",
      type: "module",
      climier: { id: "audit", command: "audit", entry: "./climier.mjs", api: 3 },
    }));
    fs.writeFileSync(path.join(installed, "climier.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "loaded"); export default { commands: { ping: () => ({ ok: true }) } };`);

    await assert.rejects(
      () => dispatchCommand({
        command: "audit",
        originalArgv: ["audit", "ping"],
        flags: {},
        projectDir: dir,
        statePath: dir,
        projectConfig: { project_id: "remote-project", backend: { type: "remote", url: "https://climier.example.test" } },
        backendClient: { type: "remote" },
      }),
      (error) => error.code === "REMOTE_UNSUPPORTED_OPERATION" && error.details.command === "audit",
    );
    assert.equal(fs.existsSync(marker), false);
    await assert.rejects(
      () => dispatchCommand({
        command: "audit",
        originalArgv: ["audit", "ping"],
        projectDir: dir,
        projectConfig: { project_id: "remote-project", backend: { type: "remote", url: "https://climier.example.test" } },
        backendClient: { type: "remote" },
      }),
      (error) => error.code === "REMOTE_UNSUPPORTED_OPERATION",
    );
    assert.equal(fs.existsSync(marker), false, "plugin entry remains unloaded for direct dispatch");
  } finally {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.promises.rm(pluginHome, { recursive: true, force: true });
    await rmTempProject(dir);
  }
});

test("dispatch: remote unsupported snapshots command fails before local handler I/O", async () => {
  const dir = await createTempProject();
  try {
    const projectConfig = { project_id: "remote-project", backend: { type: "remote", url: "https://climier.example.test" } };
    const client = { type: "remote" };
    const sourceCalls = [];
    const source = {
      registry: { lookup(...args) { sourceCalls.push(["lookup", ...args]); } },
      mutate(...args) { sourceCalls.push(["mutate", ...args]); },
    };
    fs.writeFileSync(path.join(dir, ".climier.json"), JSON.stringify(projectConfig));
    for (const commandAndFlags of [["snapshots", {}], ["restore", {}], ["ui", {}], ["init", { force: true }]]) {
      await assert.rejects(
        () => dispatchCommand({
          command: commandAndFlags[0],
          flags: commandAndFlags[1],
          projectDir: dir,
          statePath: dir,
          projectConfig,
          backendClient: client,
          source,
        }),
        (error) => error.code === "REMOTE_UNSUPPORTED_OPERATION" && error.details.command === commandAndFlags[0],
      );
    }
    for (const command of ["state", "init"]) {
      let dispatchedCommand;
      const result = await runCliInProcess({
        argv: ["--project", dir, command],
        createBackendClient: () => client,
        dispatch: async ({ command: selected }) => {
          dispatchedCommand = selected;
          return { ok: true };
        },
        write() {},
        exit() {},
      });
      assert.equal(result, 0);
      assert.equal(dispatchedCommand, command);
    }
    assert.deepEqual(sourceCalls, []);
    assert.equal(fs.existsSync(path.join(dir, ".climier.json")), true);
  } finally {
    await rmTempProject(dir);
  }
});
