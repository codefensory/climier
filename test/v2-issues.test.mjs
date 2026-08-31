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
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
}

// ---------------------------------------------------------------------------
// Issue 1: v1 stubs for cancel / resolve / deprecate-knowledge.
//
// The v1 schema is no longer supported. The bin now rejects v1 states with
// STATE_V1_UNSUPPORTED, and the v1-only commands are gone. The remaining
// surface (cancel / resolve / deprecate-knowledge) is v2-only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Issue 2: resolveAgent must run BEFORE updateState in add-node / add-edge.
// ---------------------------------------------------------------------------

test("Issue 2: add-node with missing agent does NOT mutate state (no orphan log entry)", async () => {
  const dir = await createTempProject();
  const restore = clearAgentEnv();
  try {
    await freshV2(dir);
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
    await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });

    const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
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
    // The add-initiative bootstrap writes one log entry per
    // ADR-006 §"Locks y logs" / plan §4.3 (T-plugin-policy-seam-lifecycle
    // closes the parity-slice gap). The failed add-node MUST NOT add
    // any further entries — so the log should contain exactly one
    // add-initiative entry and nothing else.
    assert.equal(s.log.length, 1, `log should contain exactly the add-initiative bootstrap entry, got ${JSON.stringify(s.log)}`);
    assert.equal(s.log[0].action, "add-initiative");
    assert.equal(s.log[0].node, "auth");
  } finally { restore(); await rmTempProject(dir); }
});

test("Issue 2: add-edge with missing agent does NOT mutate state", async () => {
  const dir = await createTempProject();
  const restore = clearAgentEnv();
  try {
    await freshV2(dir);
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
    await addInit({ statePath: dir, flags: { desc: "auth", as: "setup" }, positional: ["auth"] });
    const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
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
    // After init + add-initiative + 2 add-node setup calls we expect
    // exactly 3 log entries: add-initiative (parity-slice close,
    // ADR-006 §"Locks y logs" / plan §4.3) + 2 add-node entries.
    assert.equal(before.log.length, 3, `expected 3 setup log entries (add-initiative + 2 add-node), got ${JSON.stringify(before.log)}`);
    assert.equal(before.log[0].action, "add-initiative");
    assert.equal(before.log[1].action, "add-node");
    assert.equal(before.log[2].action, "add-node");

    const { default: addEdge } = await importFresh("./cli/commands/add-edge.mjs");
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
  // The Commands table is the canonical place where the v2 lifecycle
  // surface is described. Verify the table covers the v2-only commands
  // beyond the original six (the v1-only 'v2 scope (...)' sentinel was
  // removed when the v1 surface was dropped; the Commands table replaces
  // it as the source of truth).
  const section = text.match(/## Commands[\s\S]*?(?=\n## |\s*$)/);
  assert.ok(section, "AGENTS.md must have a '## Commands' section");
  const commands = section[0];
  for (const cmd of ["cancel", "resolve", "release", "reopen", "take", "update", "deprecate-knowledge"]) {
    assert.match(commands, new RegExp(`\\b${cmd}\\b`),
      `AGENTS.md Commands table should mention '${cmd}'`);
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
    // The v1 command no longer exists in the v2-only surface; the CLI must
    // reject the call (unknown command) and must not write anything to the
    // v2 state.
    assert.notEqual(out.code, 0, `expected non-zero exit, got ${out.code}: stdout=${out.stdout}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.ok, false);
    const msg = typeof data.error === "string" ? data.error : data.error.message;
    assert.match(msg, /unknown command|not (a|found)|v1[- ]only|v2 does not|v2 state/i, `got: ${msg}`);
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
    assert.notEqual(out.code, 0, `expected non-zero exit, got ${out.code}: stdout=${out.stdout}`);
    const data = JSON.parse(out.stdout);
    assert.equal(data.ok, false);
    const msg = typeof data.error === "string" ? data.error : data.error.message;
    assert.match(msg, /unknown command|not (a|found)|v1[- ]only|v2 does not|v2 state/i, `got: ${msg}`);
    const s = await readState(dir);
    assert.equal(s.gotchas, undefined, `gotchas collection must not be written to v2 state`);
    assert.equal(s.log.length, 0, `log should be empty`);
  } finally { await rmTempProject(dir); }
});

test("Issue 5: add-decision on v2 state is rejected as unknown command", async () => {
  // Replaces the v1 regression test: v1 commands no longer exist.
  const dir = await createTempProject();
  try {
    await freshV2(dir);
    const out = await runCli(["--project", dir, "add-decision", "D1", "--title", "pick", "--initiative", "auth"]);
    assert.notEqual(out.code, 0);
    const data = JSON.parse(out.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown command/i);
  } finally { await rmTempProject(dir); }
});

test("Issue 5: add-gotcha on v2 state is rejected as unknown command", async () => {
  // Replaces the v1 regression test: v1 commands no longer exist.
  const dir = await createTempProject();
  try {
    await freshV2(dir);
    const out = await runCli([
      "--project", dir, "add-gotcha", "G1",
      "--title", "trap", "--applies-to", "domain:db",
    ]);
    assert.notEqual(out.code, 0);
    const data = JSON.parse(out.stdout);
    assert.equal(data.ok, false);
    assert.match(data.error, /unknown command/i);
  } finally { await rmTempProject(dir); }
});