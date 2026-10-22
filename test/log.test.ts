// storage/log.ts: canonical log entry shape. Writing an entry belongs to the
// kernel mutation frontier, so this module must not export a write path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh } from "./helpers.ts";

test("prepareLogEntry adds the canonical ts and keeps caller fields", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  const entry = prepareLogEntry({ agent: "agent-1", action: "claim", task: "T1" });
  assert.equal(entry.agent, "agent-1");
  assert.equal(entry.action, "claim");
  assert.equal(entry.task, "T1");
  assert.ok(entry.ts);
  assert.equal(entry.plugin_id, undefined);
});

test("prepareLogEntry records only a non-empty plugin id", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.equal(prepareLogEntry({ agent: "a", action: "x" }, { pluginId: "   " }).plugin_id, undefined);
  assert.equal(prepareLogEntry({ agent: "a", action: "x" }, { pluginId: " p.one " }).plugin_id, "p.one");
});

test("prepareLogEntry rejects entries without action or agent", async () => {
  const { prepareLogEntry } = await importFresh("./storage/log.ts");
  assert.throws(() => prepareLogEntry(null), /prepareLogEntry: entry must be an object/);
  assert.throws(() => prepareLogEntry({ agent: "a" }), /prepareLogEntry: entry.action is required/);
  assert.throws(() => prepareLogEntry({ action: "x" }), /prepareLogEntry: entry.agent is required/);
});

test("storage/log.ts exposes no state write path", async () => {
  const logModule = await importFresh("./storage/log.ts");
  assert.equal(logModule.append, undefined);
  assert.equal(logModule.appendWithContext, undefined);
});
