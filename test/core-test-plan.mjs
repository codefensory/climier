// Shared planning for the core test runner: file discovery, in-process
// shard partitioning, and the duration table that keeps the shards balanced.

import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";

// Node added in-process test isolation in 22.8.0; Node 20 (CI matrix) has no
// flag and keeps the process-isolated path.
export function supportsInProcessIsolation() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 8);
}

export function inProcessIsolationArgs(isolation = "none") {
  const major = Number(process.versions.node.split(".")[0]);
  const flag = major >= 23 ? "--test-isolation" : "--experimental-test-isolation";
  return [`${flag}=${isolation}`];
}

export async function listTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {files.push(...await listTestFiles(entryPath));}
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {files.push(entryPath);}
  }
  return files.toSorted();
}

function median(values) {
  if (values.length === 0) {return 0;}
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Duration table format: { files: { "<path relative to repo root>": <ms> } }. */
export async function loadDurationTable(filePath, { rootDir } = {}) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    const files = parsed && typeof parsed === "object" ? parsed.files : null;
    if (!files || typeof files !== "object") {return null;}
    const table = new Map();
    for (const [key, value] of Object.entries(files)) {
      const absolute = path.resolve(rootDir ?? process.cwd(), key);
      if (Number.isFinite(value) && value > 0) {table.set(absolute, value);}
    }
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
}

// Seconds per byte from the known entries; lets fresh files share a unit with
// measured ones instead of mixing milliseconds and bytes inside one LPT pass.
function secondsPerByte(sizes, table) {
  const ratios = [];
  for (const [file, ms] of table) {
    const size = sizes.get(file);
    if (size > 0) {ratios.push(ms / 1000 / size);}
  }
  return median(ratios) || median([...table.values()]) / 1000 || 1;
}

/**
 * Greedy longest-processing-time partition. `table` maps absolute file paths
 * to measured milliseconds; unknown files are estimated from their size so
 * every weight stays in seconds.
 */
export async function partitionShards(files, workers, { table } = {}) {
  if (workers <= 1 || files.length <= 1) {
    return [files];
  }
  const sizes = new Map();
  for (const file of files) {sizes.set(file, (await stat(file)).size);}
  const perByte = table ? secondsPerByte(sizes, table) : 1;
  const weighted = files.map((file) => {
    const measured = table?.get(file);
    const weight = measured ? measured / 1000 : sizes.get(file) * perByte;
    return { file, weight };
  });
  weighted.sort((a, b) => b.weight - a.weight);
  const shards = Array.from(
    { length: Math.min(workers, weighted.length) },
    () => ({ load: 0, files: [] }),
  );
  for (const { file, weight } of weighted) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.load < target.load) {target = shard;}
    }
    target.files.push(file);
    target.load += weight;
  }
  return shards.map((shard) => shard.files);
}
