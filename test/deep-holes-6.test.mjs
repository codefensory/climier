// Deep holes — round 6: subtle behaviors, edge cases of edge cases
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// Subtle: derive on a state with circular task-decision references
test("hole: derive handles task with decision dep + decision with task dep (cross-references)", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const state = {
    tasks: { T1: { id: "T1", depends_on: ["D1"] } },
    decisions: { D1: { id: "D1" } }, // not depends_on tasks, just referenced
  };
  const r = derive(state);
  assert.deepEqual(r.blocked, ["T1"]);
  assert.deepEqual(r.openDecisions, ["D1"]);
});

// Subtle: a task that is "archived" with a block_reason should still derive correctly
test("hole: a archived task with block_reason is treated as satisfied", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const state = {
    tasks: {
      T1: { id: "T1", status: "archived", block_reason: "obsolete" },
      T2: { id: "T2", depends_on: ["T1"] },
    },
    decisions: {},
  };
  const r = derive(state);
  assert.deepEqual(r.ready, ["T2"]);
});

// Subtle: a done task still appears in the log via append? No — the log is separate.
// But a "done" task in the log should NOT have a "claim" entry of the same id missing.
test("hole: a done task with no claim in log is allowed (state was edited)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      tasks: { T1: { id: "T1", status: "done" } },
      decisions: {}, gotchas: {},
      initiatives: { x: { desc: "" } }, log: [],
    }), "utf8");
    // status should still work
    const r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// Subtle: a task with a name that contains a dot (e.g. "F.0.T1") — does anything break?
test("hole: task ids with multiple dots work", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const r1 = await runCli(["--project", dir, "add-task", "F.0.T1", "--initiative", "x", "--title", "multi-dot"]);
    assert.equal(r1.code, 0, r1.stderr);
    const r2 = await runCli(["--project", dir, "claim", "F.0.T1", "--as", "agent"]);
    assert.equal(r2.code, 0, r2.stderr);
    const r3 = await runCli(["--project", dir, "done", "F.0.T1", "ok", "--as", "agent"]);
    assert.equal(r3.code, 0, r3.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// Subtle: when a task's status is "archived" but it has claimed_by (corruption), what happens?
test("hole: a archived task with claimed_by is still done-equivalent", async () => {
  const { statusOf, derive } = await importFresh("./dag.mjs");
  const state = {
    tasks: { T1: { id: "T1", status: "archived", claimed_by: "ghost" } },
    decisions: {},
  };
  assert.equal(statusOf(state, "T1"), "archived");
  assert.deepEqual(derive(state).ready, []);
});

// Subtle: ready view when one task has no skills array
test("hole: ready works when some tasks have no skills array", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" }; // no skills
      s.tasks.T2 = { id: "T2", skills: ["ts"] };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    assert.equal(out.length, 2);
    assert.deepEqual(out.find((t) => t.id === "T1").skills, []);
  } finally {
    await rmTempProject(dir);
  }
});

// Subtle: tasks listing when one task has no title
test("hole: tasks listing when some tasks have no title", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" }; // no title
      s.tasks.T2 = { id: "T2", title: "B" };
      return s;
    });
    const out = await tasks({ statePath: dir, flags: {} });
    assert.equal(out.length, 2);
  } finally {
    await rmTempProject(dir);
  }
});

// Subtle: graph output is stable across calls
test("hole: graph output is stable across calls", async () => {
  const { default: graph } = await importFresh("./commands/graph.mjs");
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const a = await graph({ statePath: dir, flags: {} });
    const b = await graph({ statePath: dir, flags: {} });
    assert.deepEqual(a, b);
  } finally {
    await rmTempProject(dir);
  }
});

// A very long log (1000 entries) — performance smoke
test("hole: state operations remain fast with 1000 log entries", async () => {
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    // Seed with 1000 log entries
    const seed = {
      version: 1, tasks: { T1: { id: "T1" } }, decisions: {}, gotchas: {},
      initiatives: { x: { desc: "" } },
      log: Array.from({ length: 1000 }, (_, i) => ({ ts: new Date().toISOString(), agent: "a", action: "claim", task: "T1" })),
    };
    await fs.writeFile(path.join(dir, ".agents", "tasks", "tasks.json"), JSON.stringify(seed), "utf8");
    // Verify it still works
    const s = await readState(dir);
    assert.equal(s.log.length, 1000);
    // And a write still works
    const t0 = Date.now();
    await updateState(dir, (s) => {
      s.tasks.T1.title = "updated";
      return s;
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `update took ${elapsed}ms`);
  } finally {
    await rmTempProject(dir);
  }
});

// CLI handles weird but valid --flag values
test("hole: CLI accepts --flag=true (explicit) and --flag as final arg", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // --force=true is unambiguous
    const r1 = await runCli(["--project", dir, "--force=true", "init", "--seed", "migration"]);
    assert.equal(r1.code, 0, r1.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// init with --seed "" (empty) creates empty state, not migration
test("hole: init --seed '' (empty) creates empty state, not migration", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { seed: "" }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.deepEqual(s.tasks, {});
  } finally {
    await rmTempProject(dir);
  }
});

// init with --seed "anything" (unknown) creates empty state, not migration (silent fallback)
test("hole: init --seed 'unknown' silently creates empty state (not migration)", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    await init({ statePath: dir, flags: { seed: "foobar" }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.deepEqual(s.tasks, {});
  } finally {
    await rmTempProject(dir);
  }
});

// add-initiative accepts --desc with special characters
test("hole: add-initiative with --desc containing special chars", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-initiative", "x", "--desc", "special: --foo=bar, [brackets], 'quotes' \"dquotes\""]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.match(s.initiatives.x.desc, /brackets/);
  } finally {
    await rmTempProject(dir);
  }
});
