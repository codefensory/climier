import { test } from "node:test";
import assert from "node:assert/strict";

import { createTransaction } from "../src/kernel/transaction.ts";
import {
  pluginDataNodeSetProvider,
  pluginDataProjectSetProvider,
  pluginDataNodeDeleteProvider,
  pluginDataProjectDeleteProvider,
} from "../src/providers/plugin-data/index.ts";

type CaughtError = { code?: string };

function caughtError(error: unknown): CaughtError {
  return typeof error === "object" && error !== null ? error as CaughtError : {};
}

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

  const view = tx.view({ includePlugins: true }) as ReturnType<typeof tx.view> & {
    plugins: Record<string, { data: unknown }>;
  };
  assert.deepEqual(view.plugins["example.other"].data, { untouched: true });
});

test("plugin-data node provider prepares and applies without leaking value to log fields", async () => {
  const base = snapshot();
  const input = { id: "T1", value: { token: "node-secret" } };
  const req = request(input, "plugin-data.node.set");
  const plan = await pluginDataNodeSetProvider.prepare({ snapshot: base, input, request: req, pluginId: PLUGIN });
  assert.equal(plan.target.id, "T1");
  assert.deepEqual(plan.logFields, { scope: "node", node_id: "T1", key: null });
  assert.equal("value" in plan.logFields ? plan.logFields.value : undefined, undefined);
  assert.equal(plan.logAction, "plugin-data-set");

  const tx = createTransaction(base);
  const applied = await pluginDataNodeSetProvider.apply({ tx, plan });
  assert.deepEqual(applied.result, { id: "T1", value: { token: "node-secret" } });
  assert.deepEqual(tx.getNodePluginData(PLUGIN, "T1"), { token: "node-secret" });
});

test("plugin-data project provider updates only one key and is redacted", async () => {
  const base = snapshot();
  const input = { key: "token", value: "project-secret" };
  const req = request(input, "plugin-data.project.set");
  const plan = await pluginDataProjectSetProvider.prepare({ input, request: req, pluginId: PLUGIN });
  assert.equal(plan.target.id, PLUGIN);
  assert.deepEqual(plan.logFields, { scope: "project", key: "token" });
  assert.equal("value" in plan.logFields ? plan.logFields.value : undefined, undefined);

  const tx = createTransaction(base);
  const applied = await pluginDataProjectSetProvider.apply({ tx, plan });
  assert.deepEqual(applied.result, { key: "token", value: "project-secret" });
  assert.deepEqual(tx.getProjectPluginData(PLUGIN, "token"), "project-secret");
  assert.equal(tx.getProjectPluginData(PLUGIN, "keep"), true);
  assert.deepEqual(tx.pluginView()[PLUGIN].metadata, { keep: true });
});

test("plugin-data providers reject missing plugin identity and unknown node", async () => {
  const base = snapshot();
  await assert.rejects(
    pluginDataProjectSetProvider.prepare({ input: { key: "x", value: 1 }, request: { action: "plugin-data.project.set", actor: "a", input: {} }, pluginId: undefined }),
    (err) => caughtError(err).code === "MISSING_FIELD",
  );
  await assert.rejects(
    pluginDataNodeSetProvider.prepare({ snapshot: base, input: { id: "missing", value: 1 }, request: request({ id: "missing", value: 1 }, "plugin-data.node.set"), pluginId: PLUGIN }),
    (err) => caughtError(err).code === "NODE_NOT_FOUND",
  );
});

test("plugin-data set providers accept only acyclic JSON-safe values", async () => {
  const invalid = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    new Map([["x", 1]]),
    new Set([1]),
    () => 1,
    Symbol("x"),
    new Date(),
    Object.assign(Object.create({ inherited: true }), { own: true }),
  ];
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  invalid.push(circular);

  for (const value of invalid) {
    await assert.rejects(
      pluginDataNodeSetProvider.prepare({ snapshot: snapshot(), input: { id: "T1", value }, request: request({ id: "T1", value }, "plugin-data.node.set"), pluginId: PLUGIN }),
      (err) => caughtError(err).code === "PLUGIN_DATA_INVALID",
      `node value ${String(value)} should be rejected`,
    );
    await assert.rejects(
      pluginDataProjectSetProvider.prepare({ input: { key: "x", value }, request: request({ key: "x", value }, "plugin-data.project.set"), pluginId: undefined }),
      (err) => caughtError(err).code === "PLUGIN_DATA_INVALID",
      `project value ${String(value)} should be rejected`,
    );
  }

  for (const value of [null, true, "text", 0, [null, { nested: "ok" }], { nested: [1, 2] }]) {
    await assert.doesNotReject(
      pluginDataNodeSetProvider.prepare({ snapshot: snapshot(), input: { id: "T1", value }, request: request({ id: "T1", value }, "plugin-data.node.set"), pluginId: PLUGIN }),
    );
  }
});

test("plugin-data delete providers are namespaced and return removed", async () => {
  const base = snapshot();
  const nodeRequest = request({ id: "T1" }, "plugin-data.node.delete");
  const nodePlan = await pluginDataNodeDeleteProvider.prepare({ snapshot: base, input: { id: "T1" }, request: nodeRequest, pluginId: PLUGIN });
  assert.deepEqual(nodePlan.logFields, { scope: "node", node_id: "T1", key: null });
  const nodeTx = createTransaction(base);
  assert.deepEqual(await pluginDataNodeDeleteProvider.apply({ tx: nodeTx, plan: nodePlan }), { result: { removed: true }, effects: null });
  assert.equal(nodeTx.getNodePluginData(PLUGIN, "T1"), undefined);
  assert.deepEqual(nodeTx.getNode("T1").plugins["example.other"].data, { untouched: true });
  assert.deepEqual(await pluginDataNodeDeleteProvider.apply({ tx: nodeTx, plan: nodePlan }), { result: { removed: false }, effects: null });

  const projectRequest = request({ key: "old" }, "plugin-data.project.delete");
  const projectPlan = await pluginDataProjectDeleteProvider.prepare({ input: { key: "old" }, request: projectRequest, pluginId: PLUGIN });
  const projectTx = createTransaction(base);
  assert.deepEqual(await pluginDataProjectDeleteProvider.apply({ tx: projectTx, plan: projectPlan }), { result: { removed: true }, effects: null });
  assert.equal(projectTx.getProjectPluginData(PLUGIN, "old"), undefined);
  assert.deepEqual(projectTx.getProjectPluginData("example.other", "untouched"), true);
  assert.deepEqual(await pluginDataProjectDeleteProvider.apply({ tx: projectTx, plan: projectPlan }), { result: { removed: false }, effects: null });
});
