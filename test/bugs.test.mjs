// Tests for the bugs identified in the audit. These must FAIL before fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState, stateFilePath} from "./helpers.mjs";

// v1 bug #1 (block) — deleted: v1 block command no longer exists.
// v1 bug #2 (graph --initiative) — deleted: v1 graph command no longer exists; v2 status supports --initiative.

// BUG #3: withLock used to assume a pre-existing state directory.
test("bug: withLock creates the state directory if missing", async () => {
  const { withLock } = await importFresh("./lock.mjs");
  const os = await import("node:os");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "climier-bug3-"));
  try {
    let ran = false;
    await withLock(base, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    const { stateFilePath } = await import("./helpers.mjs");
    const stat = await fs.stat(path.dirname(stateFilePath(base)));
    assert.ok(stat.isDirectory());
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// BUG #4: readState throws on corrupted JSON; should return a sentinel or clear error.
test("bug: corrupted state file produces a clear error, not a SyntaxError stack", async () => {
  const { readState } = await importFresh("./storage/state.mjs");
  const dir = await createTempProject();
  try {
    const { stateFilePath } = await import("./helpers.mjs");
    const file = stateFilePath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ this is not valid json :::", "utf8");
    await assert.rejects(readState(dir), /corrupt|invalid.*json|parse/i);
  } finally {
    await rmTempProject(dir);
  }
});

// BUG #5 (coverage gap that revealed a bug): add-task with a non-existent --depends-on
// should warn or fail, not silently create a task stuck forever.
// v2 equivalent: add-task --blocked-by=NONEXISTENT must fail edge validation.
test("bug: add-task rejects --blocked-by pointing to non-existent id", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { default: addTask } = await importFresh("./commands/add-task.mjs");
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    // init first so the state file exists and the validator can run.
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["mig"] });
    await assert.rejects(
      addTask({
        statePath: dir,
        flags: {
          initiative: "mig",
          title: "x",
          body: "b",
          acceptance: "a",
          "blocked-by": "NONEXISTENT",
        },
        positional: ["T1"],
      }),
      /references missing node|not found|unknown dep|NONEXISTENT|INVALID_EDGE_TARGET/i
    );
  } finally {
    await rmTempProject(dir);
  }
});
