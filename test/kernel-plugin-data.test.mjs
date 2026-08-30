import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  rmTempProject,
  importFresh,
  writeState,
  readState,
} from "./helpers.mjs";
import {
  pluginDataNodeSetProvider,
  pluginDataProjectSetProvider,
} from "../src/providers/plugin-data/index.mjs";

const PLUGIN = "example.plugin";

function baseState() {
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
        plugins: {
          [PLUGIN]: { data: { old: true }, metadata: { keep: "node" } },
          other: { data: { untouched: true } },
        },
      },
    },
    edges: [],
    initiatives: {},
    plugins: {
      [PLUGIN]: { data: { old: "project" }, metadata: { keep: "project" } },
      other: { data: { untouched: true } },
    },
    log: [],
  };
}

async function runMutation(projectDir, provider, action, input) {
  const { mutate } = await importFresh("../src/kernel/mutate.mjs");
  return mutate({
    projectDir,
    request: { action, actor: "agent", plugin_id: PLUGIN, input },
    provider,
    pluginId: PLUGIN,
  });
}

test("kernel.mutate persists node plugin data as a node revisioned, redacted mutation", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, baseState());
    const secret = { token: "node-secret" };
    const out = await runMutation(dir, pluginDataNodeSetProvider, "plugin-data-set", {
      id: "T1",
      value: secret,
      if_revision: 4,
    });

    assert.equal(out.idempotent, false);
    assert.equal(out.diff.updated.length, 1);
    assert.equal(out.diff.updated[0].id, "T1");
    assert.equal(out.diff.updated[0].node.revision, 5);
    assert.equal(out.log_entry.action, "plugin-data-set");
    assert.equal(out.log_entry.plugin_id, PLUGIN);
    assert.deepEqual(out.log_entry, {
      ...out.log_entry,
      scope: "node",
      node_id: "T1",
      key: null,
    });
    assert.equal("value" in out.log_entry, false);
    assert.equal(JSON.stringify(out.log_entry).includes("node-secret"), false);

    const state = await readState(dir);
    assert.deepEqual(state.nodes.T1.plugins[PLUGIN], {
      data: secret,
      metadata: { keep: "node" },
    });
    assert.deepEqual(state.nodes.T1.plugins.other, { data: { untouched: true } });
    assert.deepEqual(state.plugins[PLUGIN], baseState().plugins[PLUGIN]);
  } finally {
    await rmTempProject(dir);
  }
});

test("kernel.mutate persists project plugin data without losing node/root metadata or logging values", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, baseState());
    const secret = "project-secret";
    const out = await runMutation(dir, pluginDataProjectSetProvider, "plugin-data-set", {
      key: "token",
      value: secret,
    });

    assert.equal(out.idempotent, false, "project plugin data must count as a diff");
    assert.equal(out.log_entry.action, "plugin-data-set");
    assert.equal(out.log_entry.plugin_id, PLUGIN);
    assert.equal(out.log_entry.scope, "project");
    assert.equal(out.log_entry.key, "token");
    assert.equal("value" in out.log_entry, false);
    assert.equal(JSON.stringify(out.log_entry).includes(secret), false);

    const state = await readState(dir);
    assert.deepEqual(state.plugins[PLUGIN], {
      data: { old: "project", token: secret },
      metadata: { keep: "project" },
    });
    assert.deepEqual(state.plugins.other, baseState().plugins.other);
    assert.deepEqual(state.nodes, baseState().nodes);

    const second = await runMutation(dir, pluginDataProjectSetProvider, "plugin-data-set", {
      key: "token",
      value: secret,
    });
    assert.equal(second.idempotent, true, "writing the same project value is idempotent");
    assert.equal(second.log_entry, null);
    assert.equal((await readState(dir)).log.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});
