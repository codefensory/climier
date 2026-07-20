// Audit fixes for v2 issues — see AGENTS.md audit round.
// Each test exercises one issue and one fix path; minimal scaffolding.
//
// Issue 1: cancel / resolve / deprecate-knowledge on v1 state must NOT be
//   reported as "unknown command"; they need v1 stubs that throw a clear
//   "v2-only" error. v1 release/reopen still work because their v1 modules
//   already exist.
// Issue 2: add-node and add-edge must call resolveAgent BEFORE updateState
//   so a missing agent leaves no orphan state / no orphan log entry.
// Issue 3: "Available:" error string + HELP_TEXT must list cancel, resolve,
//   history.
// Issue 4: AGENTS.md v2 description must reflect the full set of v2-capable
//   commands (take/update/status/release/resolve/reopen/cancel/deprecate-knowledge/
//   initiatives/history), not just the original six.
// Issue 5: add-decision and add-gotcha on v2 state must throw a clear
//   error instead of silently writing to a v1-style field.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  runCli,
  readState,
  stateExists,
} from "./helpers.mjs";

function clearAgentEnv() {
  const prev = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  return () => {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
  };
}

async function freshV2(dir) {
  const { default: init } = await importFresh("./commands/init.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
}

// ---------------------------------------------------------------------------
// Issue 1: v1 stubs for cancel / resolve / deprecate-knowledge.
//
// The bin routes these to v2-${cmd}.mjs when state is v2, but on a v1 state
// the dynamic import to src/commands/${cmd}.mjs raises MODULE_NOT_FOUND
// (no v1 module exists). The fix: tiny v1 stubs that throw a clear
// v2-only error so the caller gets a useful message instead of
// "unknown command 'cancel'" (which is what the MODULE_NOT_FOUND path
// currently produces).
// ---------------------------------------------------------------------------

for (const cmd of ["cancel", "resolve", "deprecate-knowledge"]) {
  test(`Issue 1: ${cmd} on a v1 state throws a clear v2-only error (NOT 'unknown command')`, async () => {
    const dir = await createTempProject();
    try {
      const r = await runCli(["--project", dir, "init"]);
      assert.equal(r.code, 0, r.stderr);
      // Provide the minimum flags the v2 commands expect; the v1 stub
      // should reject them before any field/agent validation runs.
      const extra = cmd === "deprecate-knowledge"
        ? ["--reason", "stale"]
        : cmd === "cancel"
        ? ["--reason", "abandoned"]
        : ["--note", "done"];
      const out = await runCli(["--project", dir, cmd, "X", "--as", "alice", ...extra]);
      assert.equal(out.code, 1,
        `expected exit 1 (validation/runtime error), got ${out.code}: stdout=${out.stdout} stderr=${out.stderr}`);
      const data = JSON.parse(out.stdout);
      assert.equal(data.ok, false);
      assert.equal(typeof data.error, "string", "v1 stub must emit the v1 string-error shape");
      assert.match(data.error, new RegExp(`${cmd}:.*v2|v2.*${cmd}|v2-only`, "i"),
        `expected v2-only message, got: ${data.error}`);
      assert.doesNotMatch(data.error, /unknown command/i,
        `v1 stub must NOT emit 'unknown command' (that's the bug): ${data.error}`);
    } finally { await rmTempProject(dir); }
  });
}

test("Issue 1: cancel/resolve/deprecate-knowledge v1 stubs do not mutate state or log", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0);
    const before = JSON.parse(await fs.readFile(
      path.join(process.env.CLIMIER_HOME, "projects",
        JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8")).project_id,
        "tasks.json"),
      "utf8",
    ));
    const beforeLen = before.log.length;
    const out = await runCli(["--project", dir, "cancel", "T1", "--as", "alice", "--reason", "x"]);
    assert.equal(out.code, 1);
    const after = JSON.parse(await fs.readFile(
      path.join(process.env.CLIMIER_HOME, "projects",
        JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8")).project_id,
        "tasks.json"),
      "utf8",
    ));
    assert.equal(after.log.length, beforeLen, "log should not grow on rejected v1 stub call");
  } finally { await rmTempProject(dir); }
});

test("Issue 1: release on v1 still works (no regression on existing v1 module)", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    // Seed a task + claim it, then release it.
    const state = {
      version: 1,
      tasks: { "F0.T1": { id: "F0.T1", title: "t", initiative: "x", status: "in_progress", claimed_by: "alice", claimed_at: new Date().toISOString() } },
      decisions: {}, gotchas: {}, initiatives: { x: {} }, log: [],
    };
    await fs.writeFile(path.join(process.env.CLIMIER_HOME, "projects",
      JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8")).project_id,
      "tasks.json"), JSON.stringify(state, null, 2));
    const out = await runCli(["--project", dir, "release", "F0.T1", "--as", "alice"]);
    assert.equal(out.code, 0, `stdout=${out.stdout} stderr=${out.stderr}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.task.id, "F0.T1");
  } finally { await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// Issue 2: resolveAgent must run BEFORE updateState in add-node / add-edge.
// ---------------------------------------------------------------------------

test("Issue 2: add-node with missing agent does NOT mutate state (no orphan log entry)", async () => {
  const dir = await createTempProject();
  const restore = clearAgentEnv();
  try {
    await freshV2(dir);
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });

    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    let caught;
    try {
      await addNode({
        statePath: dir,
        projectDir: dir,
        positional: ["T-orphan"],
        flags: { kind: "resolvable", subkind: "task", title: "t", initiative: "auth" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown MISSING_AGENT");
    assert.equal(caught.code, "MISSING_AGENT");

    // Critical assertion: state file must NOT contain the new node.
    const s = await readState(dir);
    assert.equal(s.nodes["T-orphan"], undefined, "node must not be created");
    // And no log entry for the failed add-node.
    assert.equal(s.log.length, 0, `log should be empty, got ${JSON.stringify(s.log)}`);
  } finally { restore(); await rmTempProject(dir); }
});

test("Issue 2: add-edge with missing agent does NOT mutate state", async () => {
  const dir = await createTempProject();
  const restore = clearAgentEnv();
  try {
    await freshV2(dir);
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });
    const { default: addNode } = await importFresh("./commands/add-node.mjs");
    await addNode({
      statePath: dir,
      positional: ["T-a"],
      flags: { kind: "resolvable", subkind: "task", title: "a", initiative: "auth", as: "setup" },
    });
    await addNode({
      statePath: dir,
      positional: ["G-b"],
      flags: { kind: "resolvable", subkind: "gate", title: "b", initiative: "auth", as: "setup" },
    });

    const before = await readState(dir);
    const beforeEdges = before.edges.length;
    // add-initiative does not log; only the two add-node setup calls do.
    assert.equal(before.log.length, 2, "expected 2 setup log entries (2 add-node calls)");

    const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
    let caught;
    try {
      await addEdge({
        statePath: dir,
        projectDir: dir,
        positional: ["T-a", "G-b"],
        flags: { type: "BLOCKS" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown MISSING_AGENT");
    assert.equal(caught.code, "MISSING_AGENT");

    const after = await readState(dir);
    assert.equal(after.edges.length, beforeEdges, `edge must not be added (before=${beforeEdges} after=${after.edges.length})`);
    assert.equal(after.log.length, before.log.length, `no new log entry (before=${before.log.length} after=${after.log.length})`);
  } finally { restore(); await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// Issue 3: "Available:" error string and HELP_TEXT completeness.
// ---------------------------------------------------------------------------

test("Issue 3: 'Available:' error string lists cancel, resolve, history", async () => {
  const dir = await createTempProject();
  try {
    // No init — no command on a bare project should produce the help-shaped error.
    const out = await runCli(["--project", dir]);
    assert.equal(out.code, 2, `expected exit 2, got ${out.code}: stdout=${out.stdout}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.ok, false);
    assert.equal(typeof data.error, "string");
    for (const cmd of ["cancel", "resolve", "history"]) {
      assert.match(data.error, new RegExp(`\\b${cmd}\\b`), `Available: string missing '${cmd}': ${data.error}`);
    }
  } finally { await rmTempProject(dir); }
});

test("Issue 3: HELP_TEXT lists cancel and resolve", async () => {
  const out = await runCli(["--help"]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /\bcancel\b/);
  assert.match(out.stdout, /\bresolve\b/);
});

// ---------------------------------------------------------------------------
// Issue 4: AGENTS.md v2 description reflects current scope.
// ---------------------------------------------------------------------------

test("Issue 4: AGENTS.md mentions the v2 lifecycle commands beyond the original six", async () => {
  const text = await fs.readFile(
    path.resolve(import.meta.dirname, "..", "AGENTS.md"),
    "utf8",
  );
  // Find the v2-scope paragraph by its leading sentinel and check the
  // paragraph (not just the sentence fragment before the first '.').
  const match = text.match(/v2 scope \([\s\S]*?\.\s/);
  assert.ok(match, "AGENTS.md must have a 'v2 scope (...)' paragraph");
  const paragraph = match[0];
  for (const cmd of ["cancel", "resolve", "release", "reopen", "take", "update", "deprecate-knowledge"]) {
    assert.match(paragraph, new RegExp(`\\b${cmd}\\b`),
      `AGENTS.md v2 description should mention '${cmd}': ${paragraph}`);
  }
});

// ---------------------------------------------------------------------------
// Issue 5: add-decision / add-gotcha must reject v2 state with a clear error.
// ---------------------------------------------------------------------------

test("Issue 5: add-decision on v2 state throws a clear v1-only error (no silent mutation)", async () => {
  const dir = await createTempProject();
  try {
    await freshV2(dir);
    const out = await runCli(["--project", dir, "add-decision", "D1", "--title", "pick", "--initiative", "x"]);
    assert.equal(out.code, 1, `expected exit 1, got ${out.code}: stdout=${out.stdout}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.ok, false);
    // v2 commands use the rich error shape; v1 commands use string. add-decision
    // is v1-only — but it should still emit a clear error explaining why.
    const msg = typeof data.error === "string" ? data.error : data.error.message;
    assert.match(msg, /v1[- ]only|v2 does not|v2 state/i, `got: ${msg}`);
    // The state file must NOT have a `decisions` collection written.
    const s = await readState(dir);
    assert.equal(s.decisions, undefined, `decisions collection must not be written to v2 state`);
    assert.equal(s.log.length, 0, `log should be empty`);
  } finally { await rmTempProject(dir); }
});

test("Issue 5: add-gotcha on v2 state throws a clear v1-only error (no silent mutation)", async () => {
  const dir = await createTempProject();
  try {
    await freshV2(dir);
    const out = await runCli([
      "--project", dir, "add-gotcha", "G1",
      "--title", "trap", "--applies-to", "domain:db",
    ]);
    assert.equal(out.code, 1, `expected exit 1, got ${out.code}: stdout=${out.stdout}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.ok, false);
    const msg = typeof data.error === "string" ? data.error : data.error.message;
    assert.match(msg, /v1[- ]only|v2 does not|v2 state/i, `got: ${msg}`);
    const s = await readState(dir);
    assert.equal(s.gotchas, undefined, `gotchas collection must not be written to v2 state`);
    assert.equal(s.log.length, 0, `log should be empty`);
  } finally { await rmTempProject(dir); }
});

test("Issue 5: add-decision still works on v1 (no regression)", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0);
    const out = await runCli([
      "--project", dir, "add-decision", "D1",
      "--title", "pick library", "--applies-to", "T1",
    ]);
    assert.equal(out.code, 0, `stdout=${out.stdout} stderr=${out.stderr}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.decision.id, "D1");
  } finally { await rmTempProject(dir); }
});

test("Issue 5: add-gotcha still works on v1 (no regression)", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0);
    const out = await runCli([
      "--project", dir, "add-gotcha", "G1",
      "--title", "trap", "--applies-to", "domain:db",
    ]);
    assert.equal(out.code, 0, `stdout=${out.stdout} stderr=${out.stderr}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.gotcha.id, "G1");
  } finally { await rmTempProject(dir); }
});