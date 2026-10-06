import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestNames } from "./test-manifest-collector.mjs";
import { findRawWriterFiles } from "./test-manifest-lanes.mjs";
import { rawLaneDeclarations } from "./test-manifest-declarations.mjs";
import { validateManifest } from "./test-manifest-checker.mjs";
import { buildManifestRows } from "./test-manifest-rows.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const manifestPath = path.join(testDir, "test-manifest.json");
const rows = await collectTestNames({ rootDir, testDir });
const rawWriterFiles = await findRawWriterFiles(testDir, rootDir);
const previous = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{\"version\":1,\"tests\":[]}"));
const tests = buildManifestRows({ rows, previous: previous.tests, declarations: rawLaneDeclarations });
const manifest = {
  version: 1,
  base_sha: previous.base_sha ?? "518af2c618d4daf1cc8839daac2242404c09d863",
  regeneration: "bun test/generate-test-manifest.mjs (runs each test file with Bun's JUnit reporter); final regeneration owner: T-v1-release-candidate",
  tests,
};
validateManifest(manifest, rows, { rawWriterFiles, rawLaneDeclarations });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
