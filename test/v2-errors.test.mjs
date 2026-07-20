// F2 — structured v2 errors.
// Tests:
//   1. errors.mjs unit tests (V2_ERROR_CODES, makeError, throwV2).
//   2. CLI integration tests: v2 commands emit { ok: false, error: { code, message, details } }.
//   3. v1 backward compat: existing v1 commands keep emitting the { ok: false, error: "<string>" } shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli, importFresh } from "./helpers.mjs";

// --- helpers ------------------------------------------------------------

function assertV2Error(data, code) {
  assert.equal(data.ok, false, "ok must be false");
  assert.ok(data.error && typeof data.error === "object", "error must be an object");
  assert.equal(typeof data.error.code, "string", "error.code must be a string");
  assert.equal(data.error.code, code, `expected code ${code}, got ${data.error.code}`);
  assert.equal(typeof data.error.message, "string", "error.message must be a string");
  assert.ok(data.error.details !== undefined, "error.details must be present");
}

async function v2Project(dir) {
  const r = await runCli(["--project", dir, "init", "--v2"]);
  assert.equal(r.code, 0, r.stderr);
  // Pre-register the default initiative used by the add-node helper below
  // so the existing error-shape tests don't all have to spell it out.
  const i = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "test"]);
  assert.equal(i.code, 0, i.stderr);
}

// --- unit tests: src/errors.mjs -----------------------------------------

test("errors.mjs: V2_ERROR_CODES is a frozen object listing every supported code", async () => {
  const { V2_ERROR_CODES } = await importFresh("./errors.mjs");
  assert.ok(Object.isFrozen(V2_ERROR_CODES), "V2_ERROR_CODES must be frozen");
  for (const code of [
    "NODE_NOT_FOUND",
    "INITIATIVE_NOT_FOUND",
    "ID_CONFLICT",
    "INVALID_EDGE_TARGET",
    "INVALID_EDGE_KIND",
    "INVALID_EDGE_TYPE",
    "SELF_EDGE",
    "CYCLE_DETECTED",
    "DUPLICATE_EDGE",
    "MISSING_AGENT",
    "MISSING_FIELD",
    "REVISION_CONFLICT",
    "NOT_READY",
    "NOT_OWNER",
    "INVALID_STATUS",
  ]) {
    assert.equal(V2_ERROR_CODES[code], code, `V2_ERROR_CODES.${code} must equal ${code}`);
  }
});

test("errors.mjs: makeError returns { ok: false, error: { code, message, details } }", async () => {
  const { makeError } = await importFresh("./errors.mjs");
  const env = makeError("SOMETHING", "it broke", { foo: 1 });
  assert.deepEqual(env, {
    ok: false,
    error: { code: "SOMETHING", message: "it broke", details: { foo: 1 } },
  });
});

test("errors.mjs: throwV2 throws an Error with .code, .details, .toJSON", async () => {
  const { throwV2, makeError } = await importFresh("./errors.mjs");
  let caught;
  try {
    throwV2("NODE_NOT_FOUND", "context: X not found", { id: "X" });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, "must throw an Error");
  assert.equal(caught.message, "context: X not found");
  assert.equal(caught.code, "NODE_NOT_FOUND");
  assert.deepEqual(caught.details, { id: "X" });
  assert.deepEqual(caught.toJSON(), makeError("NODE_NOT_FOUND", "context: X not found", { id: "X" }));
});

test("errors.mjs: toJSON output is JSON-serialisable", async () => {
  const { throwV2 } = await importFresh("./errors.mjs");
  let caught;
  try { throwV2("X", "y", { a: 1 }); } catch (e) { caught = e; }
  const round = JSON.parse(JSON.stringify(caught.toJSON()));
  assert.deepEqual(round, { ok: false, error: { code: "X", message: "y", details: { a: 1 } } });
});

// --- CLI integration: v2 commands emit the rich shape -------------------

test("CLI: add-node missing id emits MISSING_FIELD with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    const r = await runCli([
      "--project", dir, "add-node",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
    ]);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stderr}`);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "MISSING_FIELD");
    assert.equal(data.error.details.field, "id");
    assert.match(data.error.message, /^add-node:/);
  } finally { await rmTempProject(dir); }
});

test("CLI: add-node missing --kind emits MISSING_FIELD with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    const r = await runCli(["--project", dir, "add-node", "T1", "--title", "t"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "MISSING_FIELD");
    assert.equal(data.error.details.field, "kind");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-node missing --title emits MISSING_FIELD with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    const r = await runCli(["--project", dir, "add-node", "T1", "--kind", "resolvable"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "MISSING_FIELD");
    assert.equal(data.error.details.field, "title");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-node duplicate id emits ID_CONFLICT with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    let r = await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t2",
      "--initiative", "auth",
    ]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "ID_CONFLICT");
    assert.equal(data.error.details.id, "T1");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-node --blocked-by with missing target emits INVALID_EDGE_TARGET with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    const r = await runCli([
      "--project", dir, "add-node", "T-x",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
      "--blocked-by", "G-missing",
    ]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "INVALID_EDGE_TARGET");
    assert.equal(data.error.details.missing, "G-missing");
    assert.equal(data.error.details.type, "BLOCKS");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-edge missing --type emits MISSING_FIELD with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    await runCli([
      "--project", dir, "add-node", "G1",
      "--kind", "resolvable", "--subkind", "gate", "--title", "g",
      "--initiative", "auth",
    ]);
    const r = await runCli(["--project", dir, "add-edge", "T1", "G1"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "MISSING_FIELD");
    assert.equal(data.error.details.field, "type");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-edge bad --type emits INVALID_EDGE_TYPE with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    await runCli([
      "--project", dir, "add-node", "G1",
      "--kind", "resolvable", "--subkind", "gate", "--title", "g",
      "--initiative", "auth",
    ]);
    const r = await runCli(["--project", dir, "add-edge", "T1", "G1", "--type", "INFORMS"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "INVALID_EDGE_TYPE");
    assert.equal(data.error.details.type, "INFORMS");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-edge self-edge emits SELF_EDGE with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    const r = await runCli(["--project", dir, "add-edge", "T1", "T1", "--type", "BLOCKS"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "SELF_EDGE");
    assert.equal(data.error.details.from, "T1");
    assert.equal(data.error.details.to, "T1");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-edge missing target emits INVALID_EDGE_TARGET with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    const r = await runCli(["--project", dir, "add-edge", "T1", "ghost", "--type", "BLOCKS"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "INVALID_EDGE_TARGET");
    assert.equal(data.error.details.missing, "ghost");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-edge BLOCKS-to-knowledge emits INVALID_EDGE_KIND with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    await runCli([
      "--project", dir, "add-node", "K1",
      "--kind", "knowledge", "--title", "k",
      "--initiative", "auth",
    ]);
    const r = await runCli(["--project", dir, "add-edge", "T1", "K1", "--type", "BLOCKS"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "INVALID_EDGE_KIND");
    assert.equal(data.error.details.from, "T1");
    assert.equal(data.error.details.to, "K1");
    assert.equal(data.error.details.type, "BLOCKS");
    assert.equal(data.error.details.fromKind, "resolvable");
    assert.equal(data.error.details.toKind, "knowledge");
  } finally { await rmTempProject(dir); }
});

test("CLI: add-edge duplicate emits DUPLICATE_EDGE with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    await runCli([
      "--project", dir, "add-node", "T1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    await runCli([
      "--project", dir, "add-node", "G1",
      "--kind", "resolvable", "--subkind", "gate", "--title", "g",
      "--initiative", "auth",
    ]);
    let r = await runCli(["--project", dir, "add-edge", "T1", "G1", "--type", "BLOCKS"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-edge", "T1", "G1", "--type", "BLOCKS"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "DUPLICATE_EDGE");
    assert.equal(data.error.details.from, "T1");
    assert.equal(data.error.details.to, "G1");
    assert.equal(data.error.details.type, "BLOCKS");
  } finally { await rmTempProject(dir); }
});

test("CLI: context missing node emits NODE_NOT_FOUND with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    const r = await runCli(["--project", dir, "context", "ghost"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "NODE_NOT_FOUND");
    assert.equal(data.error.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});

test("CLI: context missing id emits MISSING_FIELD with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    const r = await runCli(["--project", dir, "context"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "MISSING_FIELD");
    assert.equal(data.error.details.field, "id");
  } finally { await rmTempProject(dir); }
});

test("CLI: show v2 missing node emits NODE_NOT_FOUND with details", async () => {
  const dir = await createTempProject();
  try {
    await v2Project(dir);
    const r = await runCli(["--project", dir, "show", "ghost"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assertV2Error(data, "NODE_NOT_FOUND");
    assert.equal(data.error.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});

// --- v1 backward compat: v1 commands keep the old shape -----------------

test("CLI: v1 claim without --as keeps the v1 { ok:false, error: <string> } shape", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "claim", "F0.T1"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(typeof data.error, "string", "v1 error must remain a string");
    assert.match(data.error, /--as/i);
  } finally { await rmTempProject(dir); }
});

test("CLI: v1 pre-claim on missing task keeps the v1 shape", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // Seed one task so the state file is well-formed.
    const seeded = {
      version: 1,
      tasks: { "F0.T1": { id: "F0.T1", title: "t", initiative: "x" } },
      decisions: {}, gotchas: {}, initiatives: { x: {} }, log: [],
    };
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const meta = path.join(dir, ".climier.json");
    const projectId = JSON.parse(await fs.readFile(meta, "utf8")).project_id;
    const stateFile = path.join(process.env.CLIMIER_HOME, "projects", projectId, "tasks.json");
    await fs.writeFile(stateFile, JSON.stringify(seeded, null, 2));
    const r = await runCli(["--project", dir, "pre-claim", "NOPE"]);
    assert.equal(r.code, 1);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(typeof data.error, "string", "v1 error must remain a string");
    assert.match(data.error, /not found/i);
  } finally { await rmTempProject(dir); }
});