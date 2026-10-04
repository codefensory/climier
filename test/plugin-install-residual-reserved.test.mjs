// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { requireTestModule as require } from "./plugin-install-test-helpers.mjs";
import { captureError as capture } from "./plugin-install-test-helpers.mjs";
import { RESERVED_MODULE } from "./plugin-install-test-helpers.mjs";

test("reserved-namespaces: list contains every core CLI command and is unique", () => {
  const { RESERVED_NAMESPACES, assertNoReservedCollision } = require(RESERVED_MODULE);
  assert.ok(Array.isArray(RESERVED_NAMESPACES));
  // Every core command from bin/climier.mjs HELP_TEXT must be present so

  const required = [
    "status", "context", "take", "resolve", "release", "cancel", "reopen",
    "search", "history", "show", "update", "add-note", "add-initiative",
    "add-task", "add-gate", "add-knowledge", "deprecate-knowledge", "add-node",
    "add-edge", "initiatives", "log", "init", "snapshots", "restore", "ui",
    "help", "version", "install", "uninstall",
  ];
  for (const c of required) {
    assert.ok(RESERVED_NAMESPACES.includes(c), `missing core command '${c}'`);
  }
  // Uniqueness invariant.
  const seen = new Set();
  for (const c of RESERVED_NAMESPACES) {
    assert.ok(!seen.has(c), `duplicate reserved namespace: ${c}`);
    seen.add(c);
  }
  // assertNoReservedCollision rejects each reserved name.
  for (const c of RESERVED_NAMESPACES) {
    const err = capture(() => assertNoReservedCollision(c));
    assert.ok(err, `expected throw for reserved '${c}'`);
    assert.equal(err.code, "PLUGIN_INVALID_DESCRIPTOR");
    assert.ok(err.details && Array.isArray(err.details.reserved));
  }
  // accepts a non-reserved name and missing/empty inputs.
  assert.equal(assertNoReservedCollision("my-plugin"), true);
  for (const bad of ["", " ", null, undefined, true]) {
    const err = capture(() => assertNoReservedCollision(bad));
    assert.ok(err, `expected throw for bad input ${JSON.stringify(bad)}`);
    assert.equal(err.code, "PLUGIN_INVALID_DESCRIPTOR");
  }
});
