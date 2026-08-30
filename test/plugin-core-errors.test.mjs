// T-plugin-core-foundation — `src/plugin-errors.mjs` PLUGIN_CORE_*
// additions and the central `wrapCoreError` helper.
//
// ADR-006 §"Errores" defines two errors and one wrapper for the core
// V2 plugin surface. They live next to the existing PLUGIN_* family
// in `src/plugin-errors.mjs`. The tests below are intentionally
// table-driven so the contract of each class stays obvious in diff
// review. The tests are read-only imports of the module under test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers.mjs";

const ERRORS_MODULE = "../src/plugins/errors.mjs";

// ---- PluginCoreInvalidOperation -------------------------------------

test("plugin-core-errors: PluginCoreInvalidOperation carries code, plugin_id, op, supported, reason", async () => {
  const { PluginCoreInvalidOperation } = await importFresh(ERRORS_MODULE);
  const err = new PluginCoreInvalidOperation(
    "example.audit",
    "edge.unknown",
    ["edge.add"],
    "unknown operation",
  );
  assert.equal(err.code, "PLUGIN_CORE_INVALID_OPERATION");
  assert.equal(err.details.plugin_id, "example.audit");
  assert.equal(err.details.op, "edge.unknown");
  assert.deepEqual(err.details.supported, ["edge.add"]);
  assert.equal(err.details.reason, "unknown operation");
  assert.match(err.message, /edge\.unknown/);
});

test("plugin-core-errors: PluginCoreInvalidOperation extends PluginError and is serialized via toJSON", async () => {
  const { PluginCoreInvalidOperation, PluginError } = await importFresh(ERRORS_MODULE);
  const err = new PluginCoreInvalidOperation("example.audit", "edge.unknown", ["edge.add"], "x");
  assert.ok(err instanceof PluginError);
  assert.ok(err instanceof Error);
  const json = err.toJSON();
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "PLUGIN_CORE_INVALID_OPERATION");
  assert.equal(json.error.details.op, "edge.unknown");
});

// ---- PluginCoreActionFailed -----------------------------------------

test("plugin-core-errors: PluginCoreActionFailed preserves structured cause {code, message, details}", async () => {
  const { PluginCoreActionFailed } = await importFresh(ERRORS_MODULE);
  const cause = { code: "CYCLE_DETECTED", message: "task.create would create a cycle", details: { cycle: ["T1"] } };
  const err = new PluginCoreActionFailed("example.audit", "edge.add", cause);
  assert.equal(err.code, "PLUGIN_CORE_ACTION_FAILED");
  assert.equal(err.details.plugin_id, "example.audit");
  assert.equal(err.details.op, "edge.add");
  assert.deepEqual(err.details.cause, cause);
});

test("plugin-core-errors: PluginCoreActionFailed message includes op and cause message", async () => {
  const { PluginCoreActionFailed } = await importFresh(ERRORS_MODULE);
  const err = new PluginCoreActionFailed(
    "example.audit",
    "task.take",
    { code: "NODE_NOT_FOUND", message: "task T9 not found", details: { id: "T9" } },
  );
  assert.match(err.message, /task\.take/);
  assert.match(err.message, /T9 not found/);
});

// ---- wrapCoreError --------------------------------------------------

test("plugin-core-errors: wrapCoreError keeps a structured cause and adds op + plugin_id", async () => {
  const { wrapCoreError } = await importFresh(ERRORS_MODULE);
  const raw = Object.assign(new Error("CYCLE_DETECTED"), {
    code: "CYCLE_DETECTED",
    details: { cycle: ["T1"] },
  });
  const out = wrapCoreError("example.audit", "edge.add", raw);
  assert.equal(out.code, "PLUGIN_CORE_ACTION_FAILED");
  assert.equal(out.details.plugin_id, "example.audit");
  assert.equal(out.details.op, "edge.add");
  assert.equal(out.details.cause.code, "CYCLE_DETECTED");
  assert.deepEqual(out.details.cause.details, { cycle: ["T1"] });
  assert.equal(out.details.cause.message, "CYCLE_DETECTED");
});

test("plugin-core-errors: wrapCoreError normalizes cause.code=CORE_ERROR when the core error has no code", async () => {
  const { wrapCoreError } = await importFresh(ERRORS_MODULE);
  // A bare Error thrown by Node internals or by mistake: no .code, no .details.
  const raw = new Error("disk on fire");
  const out = wrapCoreError("example.audit", "task.create", raw);
  assert.equal(out.code, "PLUGIN_CORE_ACTION_FAILED");
  assert.equal(out.details.cause.code, "CORE_ERROR");
  assert.equal(out.details.cause.message, "disk on fire");
  assert.deepEqual(out.details.cause.details, {});
});

test("plugin-core-errors: wrapCoreError accepts already structured {code,message,details} objects", async () => {
  const { wrapCoreError } = await importFresh(ERRORS_MODULE);
  const raw = { code: "REVISION_CONFLICT", message: "stale revision", details: { expected: 3 } };
  const out = wrapCoreError("example.audit", "task.update", raw);
  assert.equal(out.details.cause.code, "REVISION_CONFLICT");
  assert.deepEqual(out.details.cause.details, { expected: 3 });
});

test("plugin-core-errors: wrapCoreError accepts strings and coerces them to message-only cause", async () => {
  const { wrapCoreError } = await importFresh(ERRORS_MODULE);
  const out = wrapCoreError("example.audit", "task.release", "release failed");
  assert.equal(out.code, "PLUGIN_CORE_ACTION_FAILED");
  assert.equal(out.details.cause.code, "CORE_ERROR");
  assert.equal(out.details.cause.message, "release failed");
});

// ---- isPluginCoreError ---------------------------------------------

test("plugin-core-errors: isPluginCoreError matches both PLUGIN_CORE_* classes", async () => {
  const { isPluginCoreError, PluginCoreInvalidOperation, PluginCoreActionFailed } =
    await importFresh(ERRORS_MODULE);
  const invalid = new PluginCoreInvalidOperation("x", "y", [], "z");
  const action = new PluginCoreActionFailed("x", "y", {
    code: "CORE_ERROR",
    message: "m",
    details: {},
  });
  assert.equal(isPluginCoreError(invalid), true);
  assert.equal(isPluginCoreError(action), true);
});

test("plugin-core-errors: isPluginCoreError rejects non-plugin errors and unrelated plugin errors", async () => {
  const { isPluginCoreError } = await importFresh(ERRORS_MODULE);
  const bare = new Error("x");
  // Fake PLUGIN_HANDLER_FAILED: it has code + details but its prefix is
  // PLUGIN_HANDLER_, not PLUGIN_CORE_.
  const unrelated = Object.assign(new Error("y"), {
    code: "PLUGIN_HANDLER_FAILED",
    details: { cause: "y" },
  });
  assert.equal(isPluginCoreError(bare), false);
  assert.equal(isPluginCoreError(unrelated), false);
  // Null/undefined are tolerated.
  assert.equal(isPluginCoreError(null), false);
  assert.equal(isPluginCoreError(undefined), false);
});

test("plugin-core-errors: isPluginCoreError requires code to be a string and details to exist", async () => {
  const { isPluginCoreError } = await importFresh(ERRORS_MODULE);
  // Code starts with PLUGIN_CORE_ but details is missing.
  const missingDetails = Object.assign(new Error("x"), { code: "PLUGIN_CORE_INVALID_OPERATION" });
  // Code is not a string.
  const numeric = Object.assign(new Error("x"), { code: 1, details: {} });
  assert.equal(isPluginCoreError(missingDetails), false);
  assert.equal(isPluginCoreError(numeric), false);
});

test("plugin-core-errors: isPluginCoreError does NOT reject PLUGIN_CORE_* errors that isPluginError would accept", async () => {
  const {
    isPluginCoreError,
    isPluginError,
    PluginCoreActionFailed,
    PluginCoreInvalidOperation,
  } = await importFresh(ERRORS_MODULE);
  const invalid = new PluginCoreInvalidOperation("p", "op", [], "r");
  const action = new PluginCoreActionFailed("p", "op", {
    code: "NODE_NOT_FOUND",
    message: "x",
    details: {},
  });
  // Both predicates must agree on the same object: a true here means
  // isPluginError's PLUGIN_ prefix is broad enough; a false here means
  // we quietly broke dispatch's rewrap guard rail.
  assert.equal(isPluginError(invalid), isPluginCoreError(invalid));
  assert.equal(isPluginError(action), isPluginCoreError(action));
});

// ---- PLUGIN_CORE_* codes are isolated from the core v2 error list ---

test("plugin-core-errors: PLUGIN_CORE_* codes are not exported via V2_ERROR_CODES", async () => {
  const errorsMod = await importFresh("../src/errors.mjs");
  const set = new Set(Object.values(errorsMod.V2_ERROR_CODES));
  assert.equal(set.has("PLUGIN_CORE_INVALID_OPERATION"), false);
  assert.equal(set.has("PLUGIN_CORE_ACTION_FAILED"), false);
});

// ---- Table-driven summary -------------------------------------------

test("plugin-core-errors: table covers every PLUGIN_CORE_* class+helper", async () => {
  const mod = await importFresh(ERRORS_MODULE);
  const expectedCodes = [
    "PLUGIN_CORE_INVALID_OPERATION",
    "PLUGIN_CORE_ACTION_FAILED",
  ];
  const fixtures = [
    {
      name: "PluginCoreInvalidOperation",
      Cls: mod.PluginCoreInvalidOperation,
      args: ["example.audit", "edge.unknown", ["edge.add"], "unknown operation"],
      code: "PLUGIN_CORE_INVALID_OPERATION",
      details: { plugin_id: "example.audit", op: "edge.unknown", supported: ["edge.add"], reason: "unknown operation" },
    },
    {
      name: "PluginCoreActionFailed",
      Cls: mod.PluginCoreActionFailed,
      args: ["example.audit", "edge.add", { code: "NODE_NOT_FOUND", message: "x", details: { id: "T1" } }],
      code: "PLUGIN_CORE_ACTION_FAILED",
      details: { plugin_id: "example.audit", op: "edge.add", cause: { code: "NODE_NOT_FOUND", message: "x", details: { id: "T1" } } },
    },
  ];
  for (const f of fixtures) {
    const err = new f.Cls(...f.args);
    assert.equal(err.code, f.code, `${f.name}: code mismatch`);
    assert.deepEqual(err.details, f.details, `${f.name}: details mismatch`);
    assert.ok(
      expectedCodes.includes(err.code),
      `${f.name}: produced code ${err.code} is not in PLUGIN_CORE_* set`,
    );
    assert.ok(err instanceof mod.PluginError, `${f.name}: must extend PluginError`);
  }
  // The wrapper is exported.
  assert.equal(typeof mod.wrapCoreError, "function");
  // The narrow predicate is exported.
  assert.equal(typeof mod.isPluginCoreError, "function");
});
