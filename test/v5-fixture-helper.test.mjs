import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  createTempProject,
  exampleState,
  readState,
  rmTempProject,
  stateFilePath,
  writeFencedState,
  writeState,
} from "./helpers.mjs";
import { ledgerFile, readFencedState } from "../src/storage/ledger.mjs";

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

function v5Fixture(title, revision, fenceGeneration) {
  return {
    version: 5,
    fence_generation: fenceGeneration,
    revision,
    nodes: {
      T1: { id: "T1", title, revision: revision - 1 },
      T2: { id: "T2", title: "second", revision: revision + 1 },
    },
    edges: [],
    initiatives: {},
    log: [],
  };
}

test("writeFencedState bootstraps and replaces consistent v5 fixtures through storage APIs", async () => {
  await withProject(async (projectDir) => {
    const first = await writeFencedState(projectDir, v5Fixture("first", 40, 8));
    assert.equal(first.version, 5);
    assert.equal(first.nodes.T1.title, "first");
    assert.equal(first.fence_generation, 1);
    assert.ok(first.revision > 41);
    assert.deepEqual(Object.values(first.nodes).map((node) => node.revision), [first.revision, first.revision]);

    const replaced = await writeFencedState(projectDir, v5Fixture("replacement", 2, 99));
    assert.equal(replaced.version, 5);
    assert.equal(replaced.nodes.T1.title, "replacement");
    assert.equal(replaced.fence_generation, first.fence_generation);
    assert.equal(replaced.revision, first.revision + 1);
    assert.deepEqual(Object.values(replaced.nodes).map((node) => node.revision), [replaced.revision, replaced.revision]);

    const ledger = JSON.parse(await fs.readFile(ledgerFile(projectDir), "utf8"));
    assert.equal(ledger.fence_generation, replaced.fence_generation);
    assert.equal(ledger.high_water_revision, replaced.revision);
    assert.deepEqual(await readFencedState(projectDir), replaced);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8")), replaced);
  });
});

test("legacy helpers still write intentional v2 and v4 migration fixtures", async () => {
  await withProject(async (projectDir) => {
    await writeState(projectDir, exampleState());
    assert.equal((await readState(projectDir)).version, 2);

    const v4 = {
      version: 4,
      nodes: {},
      edges: [],
      initiatives: {},
      log: [],
      revision: 0,
    };
    await writeState(projectDir, v4);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8")), v4);
  });
});
