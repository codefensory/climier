import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  climierHome,
  projectMetaFile,
  resolveProject,
} from "../src/storage/paths.mjs";

test("storage paths resolve projects, metadata, and CLIMIER_HOME", () => {
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = "relative-climier-home";

  try {
    assert.equal(resolveProject(), process.cwd());
    assert.equal(resolveProject({ project: "relative-project" }), path.resolve("relative-project"));
    assert.equal(climierHome(), path.resolve("relative-climier-home"));
    assert.equal(projectMetaFile("/tmp/project"), "/tmp/project/.climier.json");
  } finally {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
  }
});

test("storage path fallback uses the user's home directory", () => {
  const previousHome = process.env.CLIMIER_HOME;
  delete process.env.CLIMIER_HOME;

  try {
    assert.equal(climierHome(), path.join(os.homedir(), ".climier"));
  } finally {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
  }
});
