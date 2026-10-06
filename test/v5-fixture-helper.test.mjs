import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  createTempProject,
  rmTempProject,
  exampleState,
  writeCanonicalState,
  writeFencedState,
  readState,
  stateFilePath,
} from "./helpers.mjs";
import { ledgerFile } from "../src/storage/ledger.ts";

async function withProject(fn) {
  const projectDir = await createTempProject();
  try {
    await fn(projectDir);
  } finally {
    await rmTempProject(projectDir);
  }
}

function fencedSourceFixture(title, revision, fenceGeneration = 1) {
  return {
    version: 5,
    fence_generation: fenceGeneration,
    revision,
    nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", title, status: "open", revision } },
    edges: [],
    initiatives: {},
    log: [],
  };
}

test("writeFencedState bootstraps and replaces consistent fixtures through storage APIs", async () => {
  await withProject(async (projectDir) => {
    const first = await writeFencedState(projectDir, fencedSourceFixture("first", 1));
    assert.equal(first.version, 1);
    const replaced = await writeFencedState(projectDir, fencedSourceFixture("replacement", 2, 99));
    assert.equal(replaced.version, 1);
    assert.equal(replaced.nodes.T1.title, "replacement");
    assert.equal(replaced.fence_generation, first.fence_generation);
    assert.equal(replaced.revision, first.revision + 1);
    assert.deepEqual(await fs.readFile(ledgerFile(projectDir), "utf8").then(JSON.parse).then((ledger) => [ledger.fence_generation, ledger.high_water_revision]), [replaced.fence_generation, replaced.revision]);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFilePath(projectDir), "utf8")), replaced);
  });
});

test("exampleState is a canonical version 1 fixture installed through the canonical lane", async () => {
  await withProject(async (projectDir) => {
    const fixture = exampleState();
    assert.equal(fixture.version, 1);
    const written = await writeCanonicalState(projectDir, fixture);
    assert.equal(written.version, 1);
    assert.deepEqual(await readState(projectDir), written);
  });
});
