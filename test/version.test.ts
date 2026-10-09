import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempProject, rmTempProject, runCli } from "./helpers.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version: string };

test("version command prints the package version by default", async () => {
  const project = await createTempProject();
  try {
    const result = await runCli(["--project", project, "version"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), packageJson.version);
  } finally {
    await rmTempProject(project);
  }
});

test("version --json exposes the release metadata contract", async () => {
  const project = await createTempProject();
  try {
    const result = await runCli(["--project", project, "version", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const metadata = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(metadata).toSorted(), [
      "bun",
      "commit",
      "distribution",
      "manifest_version",
      "platform",
      "release_channel",
      "state_schema",
      "version",
    ]);
    assert.equal(metadata.version, packageJson.version);
    assert.equal(metadata.release_channel, "stable");
    assert.equal(metadata.distribution, "source-link");
    assert.equal(metadata.state_schema, 1);
    assert.equal(metadata.manifest_version, 1);
    assert.equal(typeof metadata.commit, "string");
    assert.equal(typeof metadata.platform, "string");
    assert.equal(typeof metadata.bun, "string");
  } finally {
    await rmTempProject(project);
  }
});

test("--version remains plain strict-semver output", async () => {
  const project = await createTempProject();
  try {
    const result = await runCli(["--project", project, "--version"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), packageJson.version);
    assert.throws(() => JSON.parse(result.stdout));
  } finally {
    await rmTempProject(project);
  }
});
