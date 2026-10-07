import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestNames } from "./test-manifest-collector.ts";
import { findRawWriterFiles } from "./test-manifest-lanes.ts";
import { rawLaneDeclarations } from "./test-manifest-declarations.ts";
import { validateManifest } from "./test-manifest-checker.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const manifest = JSON.parse(await readFile(path.join(testDir, "test-manifest.json"), "utf8"));
const runtime = await collectTestNames({ rootDir, testDir });
const rawWriterFiles = await findRawWriterFiles(testDir, rootDir);
const allowlist = manifest.tests.filter((row) => row.disposition === "delete").map(({ path: filePath, name, ordinal }) => ({ path: filePath, name, ordinal }));
assert.equal(validateManifest(manifest, runtime, { deleteAllowlist: allowlist, rawWriterFiles, rawLaneDeclarations }), true);
console.log(`test manifest: verified ${runtime.length} runtime cases against ${manifest.tests.length} rows`);
