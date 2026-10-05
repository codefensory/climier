// Contract for the core test runner planner: file discovery, duration-table
// loading, and the LPT shard partition.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  inProcessIsolationArgs,
  listTestFiles,
  loadDurationTable,
  partitionShards,
  supportsInProcessIsolation,
} from "./core-test-plan.mjs";

test("listTestFiles discovers nested test files and ignores other modules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plan-files-"));
  try {
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "a.test.mjs"), "");
    await fs.writeFile(path.join(root, "nested", "b.test.mjs"), "");
    await fs.writeFile(path.join(root, "helpers.mjs"), "");
    const files = await listTestFiles(root);
    assert.deepEqual(files.map((file) => path.relative(root, file)), [
      "a.test.mjs",
      "nested/b.test.mjs",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadDurationTable resolves keys against the root and rejects unusable tables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plan-table-"));
  try {
    const tablePath = path.join(root, "test-durations.json");
    await fs.writeFile(tablePath, JSON.stringify({ files: { "test/a.test.mjs": 250 } }));
    const table = await loadDurationTable(tablePath, { rootDir: root });
    assert.deepEqual([...table.entries()], [[path.join(root, "test/a.test.mjs"), 250]]);

    assert.equal(await loadDurationTable(path.join(root, "missing.json"), { rootDir: root }), null);
    await fs.writeFile(tablePath, "not json");
    assert.equal(await loadDurationTable(tablePath, { rootDir: root }), null);
    await fs.writeFile(tablePath, JSON.stringify({ files: {} }));
    assert.equal(await loadDurationTable(tablePath, { rootDir: root }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("partitionShards spreads the heaviest measured files across shards", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plan-partition-"));
  try {
    const files = ["a", "b", "c"].map((name) => path.join(root, `${name}.test.mjs`));
    await Promise.all(files.map((file) => fs.writeFile(file, "")));
    const table = new Map([[files[0], 100], [files[1], 60], [files[2], 40]]);
    const shards = await partitionShards(files, 2, { table });
    assert.equal(shards.length, 2);
    assert.deepEqual(shards[0], [files[0]]);
    assert.deepEqual(shards[1].toSorted(), [files[1], files[2]].toSorted());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("partitionShards estimates unknown files from size in the table's unit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plan-estimate-"));
  try {
    const known = path.join(root, "known.test.mjs");
    const large = path.join(root, "large.test.mjs");
    const small = path.join(root, "small.test.mjs");
    await fs.writeFile(known, "x".repeat(4096));
    await fs.writeFile(large, "x".repeat(10_000));
    await fs.writeFile(small, "x".repeat(100));
    const table = new Map([[known, 1000]]);
    const shards = await partitionShards([known, large, small], 2, { table });
    assert.deepEqual(shards[0], [large], "the largest estimated file goes first");
    assert.deepEqual(shards[1].toSorted(), [known, small].toSorted());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("partitionShards keeps a single shard for one worker or one file", async () => {
  const file = "/does/not/need/to/exist.test.mjs";
  assert.deepEqual(await partitionShards([file], 8), [[file]]);
  assert.deepEqual(await partitionShards([file, "/other.test.mjs"], 1), [[file, "/other.test.mjs"]]);
});

test("isolation helpers match the Node version gate", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const expected = major > 22 || (major === 22 && minor >= 8);
  assert.equal(supportsInProcessIsolation(), expected);
  const flag = major >= 23 ? "--test-isolation" : "--experimental-test-isolation";
  assert.deepEqual(inProcessIsolationArgs("none"), [`${flag}=none`]);
});
