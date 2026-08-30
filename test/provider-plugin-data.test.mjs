import { test } from "node:test";
import assert from "node:assert/strict";

import { createTransaction } from "../src/kernel/transaction.mjs";
import { pluginDataNodeSetProvider, pluginDataProjectSetProvider } from "../src/providers/plugin-data/index.mjs";

const PLUGIN = "example.audit";

function snapshot() {
  return {
    version: 2,
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "task",
        status: "open",
        revision: 4,
        meta: { effort: "M" },
        plugins: {
          "example.audit": { data: { old: true }, metadata: { keep: true } },
          "example.other": { data: { untouched: true } },
        },
      },
    },
    edges: [],
    initiatives: {},
    plugins: {
      "example.audit": { data: { old: "project", keep: true }, metadata: { keep: true } },
      "example.other": { data: { untouched: true } },
    },
    log: [],
  };
}

function request(input, action) {
  return { action, actor: "agent", plugin_id: PLUGIN, input };
}

test("transaction plugin-data primitives isolate node and project keyspaces", () => {
  const original = snapshot();
  const tx = createTransaction(original);

  assert.deepEqual(tx.getNodePluginData(PLUGIN, "T1"), { old: true });
  assert.deepEqual(tx.getProjectPluginData(PLUGIN, "old"), "project");
  tx.setNodePluginData(PLUGIN, "T1", { secret: "node-value" });
  tx.setProjectPluginData(PLUGIN, "new-key", "project-value");

  assert.deepEqual(tx.getNode("T1").meta, { effort: "M" });
  assert.deepEqual(tx.getNode("T1").plugins["example.audit"], {
    data: { secret: "node-value" },
    metadata: { keep: true },
  });
  assert.deepEqual(tx.getNode("T1").plugins["example.other"].data, { untouched: true });
  assert.deepEqual(tx.getProjectPluginData(PLUGIN, "old"), "project");
  assert.deepEqual(tx.getProjectPluginData(PLUGIN, "new-key"), "project-value");
  assert.deepEqual(tx.getProjectPluginData("example.other", "untouched"), true);
  assert.deepEqual(tx.pluginView()[PLUGIN].metadata, { keep: true });
  assert.deepEqual(original.nodes.T1.plugins[PLUGIN].data, { old: true });
  assert.deepEqual(original.plugins[PLUGIN].data, { old: "project", keep: true });

  const view = tx.view({ includePlugins: true });
  assert.deepEqual(view.plugins["example.other"].data, { untouched: true });
});

test("plugin-data node provider prepares and applies without leaking value to log fields", async () => {
  const base = snapshot();
  const input = { id: "T1", value: { token: "node-secret" } };
  const req = request(input, "plugin-data.node.set");
  const plan = await pluginDataNodeSetProvider.prepare({ snapshot: base, input, request: req });
  assert.equal(plan.target.id, "T1");
  assert.deepEqual(plan.logFields, { scope: "node", node_id: "T1", key: null });
  assert.equal(plan.logFields.value, undefined);
  assert.equal(plan.logAction, "plugin-data-set");

  const tx = createTransaction(base);
  const applied = await pluginDataNodeSetProvider.apply({ tx, plan, input, request: req });
  assert.deepEqual(applied.result, { id: "T1", value: { token: "node-secret" } });
  assert.deepEqual(tx.getNodePluginData(PLUGIN, "T1"), { token: "node-secret" });
});

test("plugin-data project provider updates only one key and is redacted", async () => {
  const base = snapshot();
  const input = { key: "token", value: "project-secret" };
  const req = request(input, "plugin-data.project.set");
  const plan = await pluginDataProjectSetProvider.prepare({ snapshot: base, input, request: req });
  assert.equal(plan.target.id, PLUGIN);
  assert.deepEqual(plan.logFields, { scope: "project", key: "token" });
  assert.equal(plan.logFields.value, undefined);

  const tx = createTransaction(base);
  const applied = await pluginDataProjectSetProvider.apply({ tx, plan, input, request: req });
  assert.deepEqual(applied.result, { key: "token", value: "project-secret" });
  assert.deepEqual(tx.getProjectPluginData(PLUGIN, "token"), "project-secret");
  assert.equal(tx.getProjectPluginData(PLUGIN, "keep"), true);
  assert.deepEqual(tx.pluginView()[PLUGIN].metadata, { keep: true });
});

test("plugin-data providers reject missing plugin identity and unknown node", async () => {
  const base = snapshot();
  await assert.rejects(
    pluginDataProjectSetProvider.prepare({ snapshot: base, input: { key: "x", value: 1 }, request: { action: "plugin-data.project.set", actor: "a", input: {} } }),
    (err) => err.code === "MISSING_FIELD",
  );
  await assert.rejects(
    pluginDataNodeSetProvider.prepare({ snapshot: base, input: { id: "missing", value: 1 }, request: request({ id: "missing", value: 1 }, "plugin-data.node.set") }),
    (err) => err.code === "NODE_NOT_FOUND",
  );
});
