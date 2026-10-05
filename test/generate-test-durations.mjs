// Regenerates test/test-durations.json: per-file wall time measured under the
// same in-process shards the core runner uses. The runner partitions shards
// with these weights, which tracks real cost far better than file size.
//
//   node test/generate-test-durations.mjs
//
// Each file keeps the minimum across passes, so background load inflating a
// pass does not poison its weight. Re-run after large test additions or
// removals; missing entries fall back to a size estimate, so a stale table
// only degrades balance, never correctness.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  inProcessIsolationArgs,
  listTestFiles,
  loadDurationTable,
  partitionShards,
  supportsInProcessIsolation,
} from "./core-test-plan.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const durationsPath = path.join(testDir, "test-durations.json");
const workers = Math.max(1, Number(process.env.CLIMIER_TEST_WORKERS || os.availableParallelism() - 1) || 1);
const passes = Math.max(1, Number(process.env.CLIMIER_TEST_DURATION_PASSES || 3) || 1);

function runShard(shard, index, workDir) {
  return new Promise((resolve) => {
    const destination = path.join(workDir, `shard-${index}.xml`);
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      ...inProcessIsolationArgs("none"),
      "--test-reporter=junit",
      `--test-reporter-destination=${destination}`,
      ...shard,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => resolve({ index, error: error.message }));
    child.once("close", (code, signal) => resolve({ index, code, signal, stderr, destination }));
  });
}

async function collectShard(result) {
  if (result.error) {
    console.error(`generate-test-durations: shard ${result.index} failed to spawn: ${result.error}`);
    process.exitCode = 1;
    return null;
  }
  let xml;
  try {
    xml = await readFile(result.destination, "utf8");
  } catch (error) {
    console.error(`generate-test-durations: shard ${result.index} produced no report (${result.signal ?? result.code}): ${result.stderr.trim()}`);
    process.exitCode = 1;
    return null;
  }
  const durations = new Map();
  // Attribute values may contain a literal ">" (escaped test names), so a
  // plain [^>]* tag pattern would truncate the tag before file/time.
  for (const match of xml.matchAll(/<testcase\b(?:[^>"]|"[^"]*")*>/g)) {
    const file = match[0].match(/file="([^"]+)"/)?.[1];
    const time = Number(match[0].match(/time="([^"]+)"/)?.[1]);
    if (!file || !Number.isFinite(time)) {continue;}
    const absolute = path.resolve(file);
    durations.set(absolute, (durations.get(absolute) ?? 0) + time);
  }
  return durations;
}

async function measurePass(files, table, workDir) {
  const shards = await partitionShards(files, workers, { table });
  const results = await Promise.all(shards.map((shard, index) => runShard(shard, index, workDir)));
  const durations = new Map();
  for (const result of results) {
    const shardDurations = await collectShard(result);
    if (!shardDurations) {continue;}
    for (const [file, seconds] of shardDurations) {
      const milliseconds = Math.max(1, Math.round(seconds * 1000));
      const current = durations.get(file);
      if (current === undefined || milliseconds < current) {durations.set(file, milliseconds);}
    }
  }
  return durations;
}

if (!supportsInProcessIsolation()) {
  console.error(`generate-test-durations: in-process isolation requires Node >= 22.8.0 (running ${process.versions.node})`);
  process.exitCode = 1;
} else {
  const files = await listTestFiles(testDir);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "climier-durations-"));
  const measured = new Map();
  let table = await loadDurationTable(durationsPath, { rootDir });
  try {
    for (let pass = 1; pass <= passes; pass++) {
      const durations = await measurePass(files, table, workDir);
      for (const [file, milliseconds] of durations) {
        const current = measured.get(file);
        if (current === undefined || milliseconds < current) {measured.set(file, milliseconds);}
      }
      if (measured.size > 0) {table = measured;}
      console.error(`test durations: pass ${pass}/${passes} measured ${durations.size} files`);
    }
    const missing = files.filter((file) => !measured.has(file));
    const relative = Object.fromEntries(
      [...measured.entries()]
        .map(([file, milliseconds]) => [path.relative(rootDir, file).split(path.sep).join("/"), milliseconds])
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    await writeFile(durationsPath, `${JSON.stringify({
      regeneration: "node test/generate-test-durations.mjs (min across in-process JUnit passes)",
      files: relative,
    }, null, 2)}\n`);
    console.log(`test durations: recorded ${Object.keys(relative).length} files${missing.length > 0 ? ` (${missing.length} missing)` : ""}`);
    if (missing.length > 0) {
      console.log(missing.map((file) => `  missing: ${path.relative(rootDir, file)}`).join("\n"));
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
