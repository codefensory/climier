import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTempProject,
  importFresh,
  readState,
  rmTempProject,
  runCli,
} from "./helpers.mjs";

async function setupProject(dir) {
  let result = await runCli(["--project", dir, "init"]);
  assert.equal(result.code, 0, result.stdout);
  result = await runCli(["--project", dir, "add-initiative", "edge-test", "--as", "tester"]);
  assert.equal(result.code, 0, result.stdout);
  for (const id of ["T-edge-a", "T-edge-b"]) {
    result = await runCli([
      "--project", dir, "add-task", id,
      "--initiative", "edge-test", "--title", id,
      "--body", "body", "--acceptance", "acceptance", "--blocked-by", "", "--as", "tester",
    ]);
    assert.equal(result.code, 0, result.stdout);
  }
}

test("remove-edge CLI removes the exact triple and absent removal is a no-op", async () => {
  const dir = await createTempProject();
  try {
    await setupProject(dir);
    let result = await runCli([
      "--project", dir, "add-edge", "T-edge-a", "T-edge-b", "--type", "BLOCKS", "--as", "tester",
    ]);
    assert.equal(result.code, 0, result.stdout);
    const before = await readState(dir);

    result = await runCli([
      "--project", dir, "remove-edge", "T-edge-b", "T-edge-a", "--type", "BLOCKS", "--as", "tester",
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      edge: { from: "T-edge-b", to: "T-edge-a", type: "BLOCKS" },
      removed: false,
    });
    const afterNoop = await readState(dir);
    assert.deepEqual(afterNoop, before, "an absent edge must not write state or log");

    result = await runCli([
      "--project", dir, "remove-edge", "T-edge-a", "T-edge-b", "--type", "BLOCKS", "--as", "tester",
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      edge: { from: "T-edge-a", to: "T-edge-b", type: "BLOCKS" },
      removed: true,
    });
    const after = await readState(dir);
    assert.deepEqual(after.edges, []);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.log.length, before.log.length + 1);
    assert.equal(after.log.at(-1).action, "edge.remove");
  } finally {
    await rmTempProject(dir);
  }
});

test("api.core exposes edge.remove and preserves global revision on an absent removal", async () => {
  const dir = await createTempProject();
  try {
    await setupProject(dir);
    const { createCore } = await importFresh("../src/plugins/core-adapter.mjs");
    const api = createCore({ projectDir: dir, agent: "tester", pluginId: "edge.test" });
    await api.run({
      op: "edge.add",
      input: { from: "T-edge-a", to: "T-edge-b", type: "BLOCKS" },
    });
    const removed = await api.run({
      op: "edge.remove",
      input: { from: "T-edge-a", to: "T-edge-b", type: "BLOCKS" },
    });
    assert.equal(removed.result.removed, true);
    const beforeNoop = await readState(dir);
    const noop = await api.run({
      op: "edge.remove",
      input: { from: "T-edge-a", to: "T-edge-b", type: "BLOCKS" },
    });
    assert.equal(noop.result.removed, false);
    assert.equal(noop.idempotent, true);
    assert.equal(noop.log_entry, null);
    assert.deepEqual(await readState(dir), beforeNoop);
  } finally {
    await rmTempProject(dir);
  }
});
