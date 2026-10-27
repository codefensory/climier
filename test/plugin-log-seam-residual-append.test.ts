// prepareLogEntry: plugin identity shaping for the canonical log entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.ts";

test("prepareLogEntry: adds plugin_id when ctx.pluginId is a non-empty string", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  const entry = prepareLogEntry({ agent: "alice", action: "add-task", node: "T1" }, { pluginId: "example.audit" });
  assert.equal(entry.action, "add-task");
  assert.equal(entry.agent, "alice");
  assert.equal(entry.plugin_id, "example.audit");
  assert.equal(entry.node, "T1");
  assert.ok(entry.ts);
});
test("prepareLogEntry: omits plugin_id when ctx is undefined", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.equal(prepareLogEntry({ agent: "alice", action: "add-task", node: "T1" }).plugin_id, undefined);
});
test("prepareLogEntry: omits plugin_id when ctx.pluginId is missing", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.equal(prepareLogEntry({ agent: "alice", action: "add-task", node: "T1" }, {}).plugin_id, undefined);
});
test("prepareLogEntry: omits plugin_id when ctx.pluginId is not a string", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.equal(prepareLogEntry({ agent: "alice", action: "add-task", node: "T1" }, { pluginId: 42 }).plugin_id, undefined);
});
test("prepareLogEntry: omits plugin_id when ctx.pluginId is empty / whitespace", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.equal(prepareLogEntry({ agent: "alice", action: "add-task", node: "T1" }, { pluginId: "" }).plugin_id, undefined);
  assert.equal(prepareLogEntry({ agent: "alice", action: "add-task", node: "T1" }, { pluginId: "   " }).plugin_id, undefined);
});
test("prepareLogEntry: trims surrounding whitespace from pluginId", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.equal(prepareLogEntry({ agent: "alice", action: "add-task", node: "T1" }, { pluginId: "  example.audit  " }).plugin_id, "example.audit");
});
test("prepareLogEntry: rejects when entry is not an object (validation propagates)", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.throws(() => prepareLogEntry(null, { pluginId: "example.audit" }), /prepareLogEntry: entry must be an object/);
});
test("prepareLogEntry: rejects when entry.action is missing (validation propagates)", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.throws(() => prepareLogEntry({ agent: "alice" }, { pluginId: "example.audit" }), /prepareLogEntry: entry\.action is required/);
});
test("prepareLogEntry: rejects when entry.agent is missing (validation propagates)", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.throws(() => prepareLogEntry({ action: "x" }, { pluginId: "example.audit" }), /prepareLogEntry: entry\.agent is required/);
});
test("prepareLogEntry: never mutates the entry passed in by the caller", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  const entry: Record<string, unknown> = { agent: "alice", action: "add-task", node: "T1" };
  prepareLogEntry(entry, { pluginId: "example.audit" });
  assert.equal(entry.plugin_id, undefined);
  assert.equal(entry.ts, undefined);
});
