// Deep holes — round 1: functionality, robustness, UX
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// #1+#26: orphaned task (in_progress without claimed_by) — release must work for the orchestrator
test("hole: release works on orphaned task (in_progress without claimed_by) when called by orchestrator", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress" }; // no claimed_by
      return s;
    });
    await release({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, undefined);
    assert.equal(s.tasks.T1.claimed_by, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// #18: decide --as "" should NOT silently become "orchestrator"
test("hole: decide with empty --as fails instead of falling back to orchestrator", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    await assert.rejects(
      decide({ statePath: dir, flags: { as: "" }, positional: ["D1", "x"] }),
      /--as/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// #22: tasks --status should be case-insensitive
test("hole: tasks --status is case-insensitive", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" }; // ready
      s.tasks.T2 = { id: "T2", status: "done" };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: { status: "DONE" } });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "T2");
  } finally {
    await rmTempProject(dir);
  }
});

// #16+#17: invalid staleMs should error, not silently disable stale detection
test("hole: status --staleMs with non-numeric value errors", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(
      status({ statePath: dir, flags: { staleMs: "abc" } }),
      /staleMs|numeric|number/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("hole: status --staleMs 0 marks all in_progress as stale", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a", claimed_at: Date.now() };
      return s;
    });
    const out = await status({ statePath: dir, flags: { staleMs: "0" } });
    assert.equal(out.stale.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

// #19: block with empty/whitespace reason is rejected
test("hole: block with empty reason is rejected", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a" };
      return s;
    });
    await assert.rejects(
      block({ statePath: dir, flags: { as: "a" }, positional: ["T1", "   "] }),
      /reason/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// #24: depends_on not-an-array must not crash derive
test("hole: derive does not crash if a task has a non-array depends_on", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const state = { tasks: { T1: { id: "T1", depends_on: "T2" } }, decisions: {} };
  const out = derive(state);
  // Either treated as blocked (safe) or ignored — must not throw.
  assert.ok(Array.isArray(out.ready));
  assert.ok(Array.isArray(out.blocked));
});

test("hole: derive does not crash if a dep id is null", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const state = { tasks: { T1: { id: "T1", depends_on: [null] } }, decisions: {} };
  const out = derive(state);
  assert.ok(out.blocked.includes("T1"));
});

// #37: init --force overwrites existing state file
test("hole: init --force overwrites existing state", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    // Add a task
    const { addTask } = await importFresh("./commands/add-task.mjs");
    const { default: addTaskFn } = await importFresh("./commands/add-task.mjs");
    const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
    await addInit({ statePath: dir, flags: { desc: "" }, positional: ["x"] });
    await addTaskFn({ statePath: dir, flags: { initiative: "x", title: "y" }, positional: ["T1"] });
    // Re-init with --force should succeed
    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.equal(s.tasks.T1, undefined); // wiped
  } finally {
    await rmTempProject(dir);
  }
});

test("hole: init --force on missing state creates fresh", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.deepEqual(s.tasks, {});
  } finally {
    await rmTempProject(dir);
  }
});

// #40: writeState should reject invalid states (no tasks/decisions collections)
test("hole: writeState rejects an object missing required collections", async () => {
  const { writeState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      writeState(dir, { version: 1, foo: "bar" }),
      /schema|invalid.*state|missing.*collections/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// #39: readState warns or accepts state with wrong version (forward compat)
test("hole: readState surfaces a clear error for a state with a future version", async () => {
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({ version: 999, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] }), "utf8");
    const { readState } = await importFresh("./state.mjs");
    await assert.rejects(readState(dir), /version|incompatible/i);
  } finally {
    await rmTempProject(dir);
  }
});

// #36: init uses the lock to prevent races with concurrent claims
test("hole: init and claim on empty project in parallel — at least init succeeds and claim fails clean", async () => {
  const dir = await createTempProject();
  try {
    const initP = runCli(["--project", dir, "init"]);
    const claimP = (async () => {
      // small delay so init has a chance
      await new Promise((r) => setTimeout(r, 10));
      return runCli(["--project", dir, "claim", "T1", "--as", "a"]);
    })();
    const [rInit, rClaim] = await Promise.all([initP, claimP]);
    // init must succeed
    assert.equal(rInit.code, 0, rInit.stderr);
    // claim either fails clean (init won the race) OR succeeds (init lost and we got lucky)
    // in either case, no crash, no corrupt state
    const s = await readState(dir);
    assert.ok(s);
  } finally {
    await rmTempProject(dir);
  }
});
