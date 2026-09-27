import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestNames } from "./test-manifest-collector.mjs";
import { validateManifest } from "./test-manifest-checker.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const manifest = JSON.parse(await readFile(path.join(testDir, "test-manifest.json"), "utf8"));
const runtime = await collectTestNames({ rootDir, testDir });
const allowlist = manifest.tests.filter((row) => row.disposition === "delete").map(({ path: filePath, name, ordinal }) => ({ path: filePath, name, ordinal }));
assert.equal(validateManifest(manifest, runtime, { deleteAllowlist: allowlist }), true);
console.log(`test manifest: verified ${runtime.length} runtime cases against ${manifest.tests.length} rows`);
