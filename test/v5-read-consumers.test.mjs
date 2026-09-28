/* eslint-disable max-nested-callbacks -- Fenced-state read consumer assertions intentionally share one project fixture callback. */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  importFresh,
  rmTempProject,
  writeCanonicalState,
  writeState,
} from "./helpers.mjs";

function compatibleState(version = 4) {
  return {
    version,
    revision: 12,
    initiatives: { docs: { desc: "Documentation", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {
      T1: {
        id: "T1",
        kind: "resolvable",
        subkind: "task",
        title: "Document the fenced state",
        initiative: "docs",
        status: "open",
        revision: 11,
      },
      "K-needle": {
        id: "K-needle",
        kind: "knowledge",
        title: "Needle evidence",
        body: "A local consumer can read this knowledge.",
        initiative: "docs",
        status: "active",
        revision: 12,
      },
    },
    edges: [],
    log: [],
  };
}

async function withFencedProject(run) {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, compatibleState(1));
    await run(dir);
  } finally {
    await rmTempProject(dir);
  }
}

test("local show reads a canonical v1 node without exposing fence metadata", async () => {
  await withFencedProject(async (dir) => {
    const { default: show } = await importFresh("./cli/commands/show.mjs");
    const result = await show({ statePath: dir, positional: ["T1"], flags: {} });

    assert.equal(result.type, "task");
    assert.equal(result.node.id, "T1");
    assert.doesNotMatch(JSON.stringify(result), /fence_generation|ledger/);
  });
});

test("local context and search read canonical v1 node collections", async () => {
  await withFencedProject(async (dir) => {
    const { default: context } = await importFresh("./cli/commands/context.mjs");
    const { default: search } = await importFresh("./cli/commands/search.mjs");
    const contextResult = await context({ statePath: dir, positional: ["T1"], flags: {} });
    const searchResult = await search({ statePath: dir, positional: ["needle"], flags: {} });

    assert.equal(contextResult.node.id, "T1");
    assert.equal(contextResult.derived_status, "ready");
    assert.deepEqual(searchResult.matches.map(({ id }) => id), ["K-needle"]);
    assert.doesNotMatch(JSON.stringify(contextResult), /fence_generation|ledger/);
    assert.doesNotMatch(JSON.stringify(searchResult), /fence_generation|ledger/);
  });
});

test("plugin query reads canonical v1 nodes and projects no fence or ledger fields", async () => {
  await withFencedProject(async (dir) => {
    const { createQuery } = await importFresh("../src/plugins/query.mjs");
    const query = createQuery({ projectDir: dir, agent: "alice", pluginId: "plugin.a" });
    const [node, context, snapshot, status, history] = await Promise.all([
      query.node("T1"),
      query.context("T1"),
      query.snapshot(),
      query.status(),
      query.history("T1"),
    ]);

    assert.equal(node.type, "task");
    assert.equal(node.node.id, "T1");
    assert.equal(context.node.id, "T1");
    assert.equal(context.derived_status, "ready");
    assert.deepEqual(Object.keys(snapshot), ["revision", "nodes", "edges", "derived", "plugins"]);
    assert.deepEqual(snapshot.nodes.T1, node.node);
    assert.equal(status.summary.ready, 1);
    assert.deepEqual(history, { id: "T1", entries: [] });
    for (const result of [node, context, snapshot, status, history]) {
      assert.doesNotMatch(JSON.stringify(result), /fence_generation|ledger/);
    }
  });
});

test("read consumers reject legacy state versions with a migration hint", async () => {
  const dir = await createTempProject();
  try {
    const reads = [
      async (version) => {
        await writeState(dir, compatibleState(version));
        const { default: show } = await importFresh("./cli/commands/show.mjs");
        return show({ statePath: dir, positional: ["T1"], flags: {} });
      },
        async (version) => {
        await writeState(dir, compatibleState(version));
        const { default: context } = await importFresh("./cli/commands/context.mjs");
        return context({ statePath: dir, positional: ["T1"], flags: {} });
      },
      async (version) => {
        await writeState(dir, compatibleState(version));
        const { default: search } = await importFresh("./cli/commands/search.mjs");
        return search({ statePath: dir, positional: ["needle"], flags: {} });
      },
      async (version) => {
        await writeState(dir, compatibleState(version));
        const { createQuery } = await importFresh("../src/plugins/query.mjs");
        return createQuery({ projectDir: dir, agent: "alice", pluginId: "plugin.a" }).node("T1");
      },
    ];

    for (const version of [2, 3, 4, 5]) {
      for (const read of reads) {
        await assert.rejects(read(version), (error) => {
          assert.ok(["CLIMIER_INCOMPATIBLE_VERSION", "CLIMIER_STATE_NOT_READABLE"].includes(error.code));
          assert.match(error.message, /climier migrate/i);
          return true;
        });
      }
    }
  } finally {
    await rmTempProject(dir);
  }
});

test("read consumers reject future state versions", async () => {
  const dir = await createTempProject();
  try {
    await writeState(dir, compatibleState(6));
    const { default: show } = await importFresh("./cli/commands/show.mjs");
    const { default: context } = await importFresh("./cli/commands/context.mjs");
    const { default: search } = await importFresh("./cli/commands/search.mjs");
    const { createQuery } = await importFresh("../src/plugins/query.mjs");
    const query = createQuery({ projectDir: dir, agent: "alice", pluginId: "plugin.a" });
    const reads = [
      () => show({ statePath: dir, positional: ["T1"], flags: {} }),
      () => context({ statePath: dir, positional: ["T1"], flags: {} }),
      () => search({ statePath: dir, positional: ["needle"], flags: {} }),
      () => query.node("T1"),
      () => query.context("T1"),
      () => query.snapshot(),
      () => query.status(),
      () => query.history("T1"),
    ];

    for (const read of reads) {
      await assert.rejects(read, (error) => {
        assert.equal(error.code, "CLIMIER_INCOMPATIBLE_VERSION");
        assert.match(error.message, /version 6/);
        return true;
      });
    }
  } finally {
    await rmTempProject(dir);
  }
});
