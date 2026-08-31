// Regression coverage for retiring meta.execution semantics from the core.
// The metadata remains opaque and is never validated, normalized, or projected
// as an execution contract or ownership signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState as readRawState,
  writeState as writeRawState,
} from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseState = () => ({ version: 2, initiatives: {}, nodes: {}, edges: [], log: [] });

async function bootstrap(dir) {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  await init({ statePath: dir, projectDir: dir, positional: [], flags: { v2: true } });
  const { default: addInitiative } = await importFresh("./cli/commands/add-initiative.mjs");
  await addInitiative({
    statePath: dir,
    projectDir: dir,
    positional: ["wf"],
    flags: { desc: "workflow", as: "test-agent" },
  });
}

async function addTask(dir, id, extraFlags = {}) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    projectDir: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: "X",
      initiative: "wf",
      as: "test-agent",
      ...extraFlags,
    },
  });
}

test("execution modules and compatibility facade are removed", async () => {
  for (const relative of [
    "src/execution/index.mjs",
    "src/execution/contract.mjs",
    "src/execution/conflicts.mjs",
    "src/contracts/execution-contract.mjs",
  ]) {
    await assert.rejects(fs.access(path.join(ROOT, relative)), { code: "ENOENT" });
  }
});

test("add-node preserves malformed meta.execution as opaque metadata", async () => {
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    const meta = {
      ticket: "WF-1",
      execution: {
        effort: "XL",
        risk: "not-a-core-value",
        owns: [" src/foo.mjs ", 7],
        arbitrary: { preserved: true },
      },
    };
    await addTask(dir, "T-opaque", { meta: JSON.stringify(meta) });
    const state = await readRawState(dir);
    assert.deepEqual(state.nodes["T-opaque"].meta, meta);
  } finally {
    await rmTempProject(dir);
  }
});

test("update preserves malformed meta.execution as opaque metadata", async () => {
  const { default: update } = await importFresh("./cli/commands/update.mjs");
  const dir = await createTempProject();
  try {
    await bootstrap(dir);
    await addTask(dir, "T-update");
    const meta = { execution: { effort: "XL", owns: [], extra: ["opaque"] }, ticket: "WF-2" };
    await update({
      statePath: dir,
      projectDir: dir,
      positional: ["T-update"],
      flags: { meta: JSON.stringify(meta), as: "test-agent" },
    });
    const state = await readRawState(dir);
    assert.deepEqual(state.nodes["T-update"].meta, meta);
  } finally {
    await rmTempProject(dir);
  }
});

test("context does not project execution or ownership fields", async () => {
  const { default: context } = await importFresh("./cli/commands/context.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-context": {
          id: "T-context",
          kind: "resolvable",
          subkind: "task",
          title: "Context",
          revision: 1,
          status: "open",
          meta: { execution: { effort: "XL", owns: ["src/x.mjs"] }, ticket: "WF-3" },
        },
      },
    });
    const out = await context({ statePath: dir, positional: ["T-context"], flags: {} });
    assert.equal("execution_contract" in out, false);
    assert.equal("ownership_conflicts" in out, false);
    assert.deepEqual(out.node.meta, {
      execution: { effort: "XL", owns: ["src/x.mjs"] },
      ticket: "WF-3",
    });
    assert.equal(out.alerts.some((alert) => alert.kind === "OWNERSHIP_CONFLICT"), false);
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin query context does not project execution or ownership fields", async () => {
  const { createQuery } = await importFresh("./plugins/query.mjs");
  const dir = await createTempProject();
  try {
    await writeRawState(dir, {
      ...baseState(),
      nodes: {
        "T-query": {
          id: "T-query",
          kind: "resolvable",
          subkind: "task",
          title: "Query",
          revision: 1,
          status: "open",
          meta: { execution: { risk: "opaque" } },
        },
      },
    });
    const out = await createQuery({ projectDir: dir, agent: "test-agent" }).context("T-query");
    assert.equal("execution_contract" in out, false);
    assert.equal("ownership_conflicts" in out, false);
    assert.deepEqual(out.node.meta, { execution: { risk: "opaque" } });
  } finally {
    await rmTempProject(dir);
  }
});
