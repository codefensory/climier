// plugin-compat.test.mjs — CLI dispatch contracts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  readState,
  writeState,
  bootstrapState,
  seedPluginData,
  assertPluginDataPreserved,
  runCli,
} from "./plugin-compat-helpers.mjs";

test("CLI: init --force preserves root plugins via bin", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    const r = await runCli(["--project", dir, "init", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: snapshot + restore preserves plugin data via bin", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeState(dir, base);
    r = await runCli(["--project", dir, "init", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    const list = await runCli(["--project", dir, "snapshots"]);
    const { snapshots } = JSON.parse(list.stdout);
    const targetId = snapshots[0].id;
    // Wipe the state to a no-plugins shape.
    await writeState(dir, {
      version: 2,
      nodes: {},
      edges: [],
      initiatives: {},
      log: [],
    });
    r = await runCli(["--project", dir, "restore", targetId, "--as", "test-agent"]);
    assert.equal(r.code, 0, r.stderr);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});
