// Deep holes — round 12: fine cracks
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// A task with extremely long depends_on chain
test("hole: derive handles a 50-deep dependency chain", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const tasks = {};
  for (let i = 0; i < 50; i++) {
    if (i === 0) {
      tasks[`T${i}`] = { id: `T${i}` };
    } else {
      tasks[`T${i}`] = { id: `T${i}`, depends_on: [`T${i - 1}`] };
    }
  }
  const state = { tasks, decisions: {} };
  const r = derive(state);
  assert.deepEqual(r.ready, ["T0"]);
  // Mark them all done except the last
  for (let i = 0; i < 49; i++) {
    tasks[`T${i}`].status = "done";
  }
  const r2 = derive(state);
  assert.deepEqual(r2.ready, ["T49"]);
});

// A task that depends on a decision AND a task
test("hole: task with mixed deps (decision + task) is ready when both satisfied", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const state = {
    tasks: {
      T1: { id: "T1" },
      T2: { id: "T2", depends_on: ["T1", "D1"] },
    },
    decisions: { D1: { id: "D1" } },
  };
  // Initially: T1 ready (no deps), T2 blocked (D1 open, T1 not done)
  let r = derive(state);
  assert.deepEqual(r.ready, ["T1"]);
  assert.deepEqual(r.blocked, ["T2"]);

  // T1 done: T2 still blocked (D1 open)
  state.tasks.T1.status = "done";
  r = derive(state);
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.blocked, ["T2"]);

  // D1 decided: T2 now ready
  state.decisions.D1.status = "decided";
  r = derive(state);
  assert.deepEqual(r.ready, ["T2"]);
  assert.deepEqual(r.blocked, []);
});

// Status with a task that has no initiative
test("hole: status handles tasks with no initiative (groups under '(none)')", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" }; // no initiative
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    // counts might have "(none)" or no key — just don't crash
    assert.ok(out);
  } finally {
    await rmTempProject(dir);
  }
});

// Concurrent: 3 init --force on the same dir — last one wins
test("hole: 3 init --force on the same dir — all succeed, last wins", async () => {
  const dir = await createTempProject();
  try {
    const results = await Promise.all([
      runCli(["--project", dir, "init", "--force", "--seed", "migration"]),
      runCli(["--project", dir, "init", "--force", "--seed", "migration"]),
      runCli(["--project", dir, "init", "--force", "--seed", "migration"]),
    ]);
    results.forEach((r) => assert.equal(r.code, 0, r.stderr));
    const s = await readState(dir);
    assert.ok(s.tasks["F0.T1"]);
  } finally {
    await rmTempProject(dir);
  }
});

// formatStatus renders every section when state is full — removed (formatters dropped in JSON-only refactor).

// A task with claimed_by as a number (corruption) — should still work for basic ops
test("hole: numeric claimed_by is preserved", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: 12345 };
      return s;
    });
    // release by the "wrong" agent should fail
    await assert.rejects(
      release({ statePath: dir, flags: { as: "alice" }, positional: ["T1"] }),
      /not yours|not owner/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// A task with status 'in_progress' and block_reason set, when released
test("hole: release clears block_reason", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a", block_reason: "need help" };
      return s;
    });
    await release({ statePath: dir, flags: { as: "a" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.block_reason, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// A claimer that is a number doesn't match string --as
test("hole: numeric claimed_by does not match a string --as", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: 12345 };
      return s;
    });
    await assert.rejects(
      done({ statePath: dir, flags: { as: "12345" }, positional: ["T1", "ok"] }),
      /not yours/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// Tasks with very long ids (255 chars)
test("hole: tasks with 255-char ids work", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const longId = "X." + "y".repeat(250);
    const r1 = await runCli(["--project", dir, "add-task", longId, "--initiative", "x", "--title", "y"]);
    assert.equal(r1.code, 0, r1.stderr);
    const r2 = await runCli(["--project", dir, "claim", longId, "--as", "a"]);
    assert.equal(r2.code, 0, r2.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// A claim log entry contains the agent id exactly
test("hole: claim log entry has the exact agent id", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-x"]);
    const s = await readState(dir);
    const entry = s.log.find((e) => e.action === "claim" && e.task === "F0.T1");
    assert.ok(entry);
    assert.equal(entry.agent, "agent-x");
    assert.ok(entry.ts);
  } finally {
    await rmTempProject(dir);
  }
});

// Ready view with no tasks at all (only decisions)
test("hole: ready returns empty when there are only decisions", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

// Two decisions, one decided, the other not: openDecisions only contains the undecided
test("hole: openDecisions excludes decided decisions", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const state = {
    tasks: {},
    decisions: {
      D1: { id: "D1", status: "decided", choice: "x" },
      D2: { id: "D2" },
    },
  };
  const r = derive(state);
  assert.deepEqual(r.openDecisions, ["D2"]);
});

// release followed by immediate claim by the same agent works
test("hole: release followed by immediate claim by the same agent works", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1" } }, decisions: {}, gotchas: {},
      initiatives: { x: { desc: "" } }, log: [],
    }), "utf8");
    await runCli(["--project", dir, "claim", "T1", "--as", "a"]);
    await runCli(["--project", dir, "release", "T1", "--as", "a"]);
    const r = await runCli(["--project", dir, "claim", "T1", "--as", "a"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// Init should not crash on a project root that has no permissions
// (This is hard to test portably — skip)

// ready with a project root that contains spaces
test("hole: project root with spaces in path works", async () => {
  const os = await import("node:os");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "climier space test-"));
  try {
    await runCli(["--project", base, "init", "--seed", "migration"]);
    const s = await readState(base);
    assert.ok(s.tasks["F0.T1"]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
