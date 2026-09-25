import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createTempProject, rmTempProject } from "./helpers.mjs";
import { stateFile } from "../src/storage/state.mjs";
import { ledgerFile, bootstrapFencedState, replaceFencedStateUnderLock, readFencedState, commitFencedStateUnderLock } from "../src/storage/ledger.mjs";
import { withLock } from "../src/storage/lock.mjs";
import { transferState } from "../src/kernel/transfer.mjs";

function projectState(overrides = {}) {
  return {
    version: 4,
    revision: 0,
    nodes: {
      T1: { id: "T1", kind: "resolvable", subkind: "task", status: "open", revision: 0, title: "source" },
    },
    edges: [],
    initiatives: { demo: { desc: "demo" } },
    log: [{ action: "source-event", agent: "author" }],
    ...overrides,
  };
}

async function withProjects(fn) {
  const sourceDir = await createTempProject();
  const destinationDir = await createTempProject();
  try {
    await fn(sourceDir, destinationDir);
  } finally {
    await rmTempProject(sourceDir);
    await rmTempProject(destinationDir);
  }
}

async function initialize(projectDir, state = projectState()) {
  await bootstrapFencedState(projectDir);
  if (state) {
    await withLock(projectDir, (lockContext) => replaceFencedStateUnderLock(lockContext, state));
  }
}

async function rawState(projectDir) {
  return JSON.parse(await fs.readFile(stateFile(projectDir), "utf8"));
}

async function rawLedger(projectDir) {
  return JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
}

const runTransfer = (sourceProjectDir, destinationProjectDir, options = {}) => transferState({
  sourceProjectDir,
  destinationProjectDir,
  actor: "alice",
  direction: "push",
  ...options,
});

test("kernel transfer bootstraps absent destination and replaces its log with source log plus one event", async () => {
  await withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    const result = await runTransfer(sourceDir, destinationDir);
    assert.equal(result.nodes.T1.title, "source");
    assert.deepEqual(result.log.slice(0, -1), [{ action: "source-event", agent: "author" }]);
    assert.equal(result.log.length, 2);
    assert.equal(result.log.at(-1).action, "transfer.push");
    assert.equal(result.log.at(-1).agent, "alice");
    assert.ok(result.log.at(-1).ts);
    assert.equal(result.fence_generation, 1);
    assert.ok(result.revision > 0);
    assert.ok(Object.values(result.nodes).every((node) => node.revision === result.revision));
    assert.deepEqual(await readFencedState(destinationDir), result);
    assert.equal((await rawLedger(destinationDir)).high_water_revision, result.revision);
    const source = await readFencedState(sourceDir);
    assert.equal(result.fence_generation, source.fence_generation);
    assert.ok(result.nodes.T1.revision <= result.revision);
  });
});

test("kernel transfer accepts pristine initialized destination but create-only conflict preserves it", async (t) => {
  await t.test("pristine", async () => withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    await initialize(destinationDir, null);
    const result = await runTransfer(sourceDir, destinationDir);
    assert.equal(result.nodes.T1.title, "source");
  }));
  await t.test("non-pristine conflict", async () => withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    await initialize(destinationDir, projectState({ nodes: { T2: { id: "T2", kind: "resolvable", status: "open", revision: 0 } } }));
    const beforeState = await fs.readFile(stateFile(destinationDir), "utf8");
    const beforeLedger = await fs.readFile(ledgerFile(destinationDir), "utf8");
    await assert.rejects(runTransfer(sourceDir, destinationDir), { code: "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE" });
    assert.equal(await fs.readFile(stateFile(destinationDir), "utf8"), beforeState);
    assert.equal(await fs.readFile(ledgerFile(destinationDir), "utf8"), beforeLedger);
  }));
});

test("kernel transfer overwrite is absolute, rejects plugin destinations, and rebases local revisions", async (t) => {
  await t.test("absolute overwrite", async () => withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    const destinationState = projectState({
      nodes: { OLD: { id: "OLD", kind: "resolvable", status: "open", revision: 0 } },
      revision: 8,
      log: [{ action: "destination-only", agent: "bob" }],
    });
    await initialize(destinationDir, destinationState);
    const before = await readFencedState(destinationDir);
    const result = await runTransfer(sourceDir, destinationDir, { overwrite: true });
    assert.deepEqual(Object.keys(result.nodes), ["T1"]);
    assert.ok(result.revision > before.revision);
    assert.ok(Object.values(result.nodes).every((node) => node.revision === result.revision));
    assert.equal((await rawLedger(destinationDir)).fence_generation, before.fence_generation);
    assert.equal(result.log.some((entry) => entry.action === "destination-only"), false);
    assert.equal(result.log.filter((entry) => entry.action === "transfer.push").length, 1);
  }));
  await t.test("plugin data rejected even on overwrite", async () => withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    await initialize(destinationDir, projectState({ plugins: { demo: { value: true } } }));
    const beforeState = await fs.readFile(stateFile(destinationDir), "utf8");
    await assert.rejects(runTransfer(sourceDir, destinationDir, { overwrite: true }), { code: "CLIMIER_TRANSFER_PLUGIN_DATA" });
    assert.equal(await fs.readFile(stateFile(destinationDir), "utf8"), beforeState);
  }));
});

test("kernel transfer rejects source claims, in-progress tasks, and plugin data", async (t) => {
  for (const [label, overrides] of [
    ["claim", { nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", status: "open", claim: { by: "worker" }, revision: 0 } } }],
    ["in_progress", { nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", status: "in_progress", revision: 0 } } }],
    ["root plugin data", { plugins: { demo: { value: true } } }],
    ["node plugin data", { nodes: { T1: { id: "T1", kind: "resolvable", status: "open", plugins: { demo: { value: true } }, revision: 0 } } }],
  ]) {
    await t.test(label, async () => withProjects(async (sourceDir, destinationDir) => {
      await initialize(sourceDir, projectState(overrides));
      await assert.rejects(runTransfer(sourceDir, destinationDir), { code: "CLIMIER_TRANSFER_INVALID_SOURCE" });
      await assert.rejects(fs.access(stateFile(destinationDir)), { code: "ENOENT" });
    }));
  }
});

test("kernel transfer rejects a fenced source whose state regressed from its ledger", async () => {
  await withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    const state = await rawState(sourceDir);
    state.fence_generation += 1;
    await fs.writeFile(stateFile(sourceDir), `${JSON.stringify(state, null, 2)}\n`);
    await assert.rejects(runTransfer(sourceDir, destinationDir), { code: "CLIMIER_LEDGER_STATE_MISMATCH" });
    await assert.rejects(fs.access(stateFile(destinationDir)), { code: "ENOENT" });
  });
});

test("kernel transfer recovery delegates to fenced ledger before source capture", async () => {
  await withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    const candidate = await readFencedState(sourceDir);
    candidate.nodes.T1.title = "pending valid source";
    await withLock(sourceDir, async (lockContext) => {
      await assert.rejects(commitFencedStateUnderLock(lockContext, {
        ...candidate,
        revision: candidate.revision + 1,
        nodes: Object.fromEntries(Object.entries(candidate.nodes).map(([id, node]) => [id, { ...node, revision: candidate.revision + 1 }])),
        log: [...candidate.log, { action: "pending-source" }],
      }, { faultAt: "after-state-rename" }), /injected failure/);
    });
    const transferred = await runTransfer(sourceDir, destinationDir);
    assert.equal(transferred.nodes.T1.title, "pending valid source");
    assert.equal(transferred.log.filter((entry) => entry.action === "transfer.push").length, 1);
    const sourceLedger = await rawLedger(sourceDir);
    assert.equal(sourceLedger.commit_pending, null);
  });
});

test("kernel transfer create-only race serializes and only one caller installs", async () => {
  await withProjects(async (sourceDir, destinationDir) => {
    await initialize(sourceDir);
    const results = await Promise.allSettled([
      runTransfer(sourceDir, destinationDir),
      runTransfer(sourceDir, destinationDir),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "CLIMIER_TRANSFER_DESTINATION_NOT_PRISTINE");
    const finalState = await readFencedState(destinationDir);
    assert.equal(finalState.log.filter((entry) => entry.action === "transfer.push").length, 1);
  });
});
