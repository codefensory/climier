import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestNames } from "./test-manifest-collector.mjs";
import { findRawWriterFiles } from "./test-manifest-lanes.mjs";
import { rawLaneDeclarations } from "./test-manifest-declarations.mjs";
import { validateManifest } from "./test-manifest-checker.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const manifestPath = path.join(testDir, "test-manifest.json");
const rows = await collectTestNames({ rootDir, testDir });
const rawWriterFiles = await findRawWriterFiles(testDir, rootDir);
const previous = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{\"version\":1,\"tests\":[]}"));
const priorByKey = new Map(previous.tests.map((row) => [JSON.stringify([row.path, row.name, row.ordinal]), row]));
const ordinalByName = new Map();
const tests = rows.map(({ path: filePath, name }) => {
  const base = JSON.stringify([filePath, name]);
  const ordinal = (ordinalByName.get(base) ?? 0) + 1;
  ordinalByName.set(base, ordinal);
  const prior = priorByKey.get(JSON.stringify([filePath, name, ordinal]));
  if (prior?.disposition === "delete") return prior;
  const declaration = rawLaneDeclarations[filePath];
  return {
    path: filePath,
    name,
    ordinal,
    disposition: prior?.disposition ?? "keep",
    ...(declaration ? { lane: "raw", ...declaration } : {}),
  };
});
const staleDeletes = previous.tests.filter((row) => row.disposition === "delete" && !tests.some((current) => current.path === row.path && current.name === row.name && current.ordinal === row.ordinal));
tests.push(...staleDeletes);
tests.sort((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name) || left.ordinal - right.ordinal);
const manifest = {
  version: 1,
  base_sha: previous.base_sha ?? "518af2c618d4daf1cc8839daac2242404c09d863",
  regeneration: "node test/generate-test-manifest.mjs (runs each test file with node --test --test-reporter=tap); final regeneration owner: T-v1-release-candidate",
  tests,
};
validateManifest(manifest, rows, { rawWriterFiles, rawLaneDeclarations });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
