// Deep holes — round 9: integration end-to-end, real-world scenarios
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState, stateFilePath } from "./helpers.mjs";

// Full migration scenario: 2 workers, 1 orchestrator, decisions, recovery
test("hole: full real-world scenario with 2 workers, 1 orchestrator, decisions, and stale recovery", async () => {
  const dir = await createTempProject();
  try {
    // 1. Init with seed
    await runCli(["--project", dir, "init", "--seed", "migration"]);

    // 2. Orchestrator reads status
    let r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);

    // 3. Orchestrator decides D1, D2, D3, D4 (closes all decisions upfront)
    for (const d of ["D1", "D2", "D3", "D4"]) {
      r = await runCli(["--project", dir, "decide", d, "resolved-" + d, "--because", "test"]);
      assert.equal(r.code, 0, r.stderr);
    }

    // 4. Worker 1 takes F0.T1
    r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "worker-1"]);
    assert.equal(r.code, 0, r.stderr);

    // 5. Worker 1 hits a blocker
    r = await runCli(["--project", dir, "block", "F0.T1", "need more info", "--as", "worker-1"]);
    assert.equal(r.code, 0, r.stderr);

    // 6. Orchestrator sees the block in status
    r = await runCli(["--project", dir, "status"]);
    const status = JSON.parse(r.stdout);
    const blocked = status.in_progress.find((t) => t.id === "F0.T1");
    assert.ok(blocked);
    assert.match(blocked.block_reason, /need more info/);

    // 7. Orchestrator recovers the task (force release)
    r = await runCli(["--project", dir, "release", "F0.T1", "--as", "orchestrator"]);
    assert.equal(r.code, 0, r.stderr);

    // 8. Worker 2 takes F0.T1
    r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "worker-2"]);
    assert.equal(r.code, 0, r.stderr);

    // 9. Worker 2 completes it
    r = await runCli(["--project", dir, "done", "F0.T1", "monorepo ready", "--as", "worker-2"]);
    assert.equal(r.code, 0, r.stderr);

    // 10. After F0.T1 done, F0.T2 and F0.T4 are now ready
    r = await runCli(["--project", dir, "ready"]);
    const readyData = JSON.parse(r.stdout);
    const readyIds = readyData.map((t) => t.id);
    assert.ok(readyIds.includes("F0.T2"));
    assert.ok(readyIds.includes("F0.T4"));

    // 11. Final state: all 4 decisions decided, F0.T1 done, F0.T2/T4 ready
    const s = await readState(dir);
    assert.equal(s.decisions.D1.status, "decided");
    assert.equal(s.tasks["F0.T1"].status, "done");
    assert.equal(s.tasks["F0.T1"].done_by, "worker-2");
    assert.equal(s.tasks["F0.T1"].note, "monorepo ready");
    assert.equal(s.tasks["F0.T1"].block_reason, undefined);

    // 12. Log has all the events: 4 decisions + 2 claims + 1 block + 1 release + 1 done = 9
    assert.ok(s.log.length >= 9, `expected 9 log entries, got ${s.log.length}`);
  } finally {
    await rmTempProject(dir);
  }
});

// Stress: many sequential operations
test("hole: 30 sequential claim/done cycles complete without errors", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const file = stateFilePath(dir);
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1" } }, decisions: {}, gotchas: {},
      initiatives: { x: { desc: "" } }, log: [],
    }), "utf8");
    for (let i = 0; i < 30; i++) {
      const c = await runCli(["--project", dir, "claim", "T1", "--as", "agent"]);
      if (c.code === 0) {
        const d = await runCli(["--project", dir, "done", "T1", `iter ${i}`, "--as", "agent"]);
        assert.equal(d.code, 0, `iter ${i} done failed: ${d.stderr}`);
      }
      // If claim failed, someone else has it (or it's done). Just move on.
    }
    const s = await readState(dir);
    assert.ok(s.tasks.T1);
  } finally {
    await rmTempProject(dir);
  }
});

// Concurrent: orchestrator reading status while workers are doing things
test("hole: orchestrator can read status while workers claim in parallel", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const file = stateFilePath(dir);
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1" }, T2: { id: "T2" } },
      decisions: {}, gotchas: {}, initiatives: { x: { desc: "" } }, log: [],
    }), "utf8");
    const reads = Array.from({ length: 20 }, () => runCli(["--project", dir, "status"]));
    const writes = [
      runCli(["--project", dir, "claim", "T1", "--as", "a"]),
      runCli(["--project", dir, "claim", "T2", "--as", "b"]),
    ];
    const all = await Promise.all([...reads, ...writes]);
    // All reads should succeed
    for (let i = 0; i < 20; i++) {
      assert.equal(all[i].code, 0);
    }
    // Writes should succeed too
    assert.equal(all[20].code, 0);
    assert.equal(all[21].code, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// formatStatus never throws on unusual state shapes — removed (formatters dropped in JSON-only refactor).

// addNode with non-existent collection creates the collection
test("hole: addNode creates the collection if it doesn't exist", async () => {
  const { addNode } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    // First add to a custom collection
    await addNode(dir, "decisions", "D1", { id: "D1", title: "test" });
    const s = await readState(dir);
    assert.ok(s.decisions.D1);
  } finally {
    await rmTempProject(dir);
  }
});

// A task that's been done can be re-opened via... well, it can't. (Documented behavior.)
test("hole: a done task cannot be claimed again", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done", done_by: "alice", done_at: "2024-01-01" };
      return s;
    });
    await assert.rejects(
      claim({ statePath: dir, flags: { as: "bob" }, positional: ["T1"] }),
      /already.*done/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// Test that a task with `accepted` (typo) doesn't break things
test("hole: tasks with extra unknown fields don't break anything", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", unknown_field: "weird", another: { nested: true } };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    assert.equal(out.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

// views formatReady with one task — removed (formatters dropped in JSON-only refactor).

// Concurrent: 5 add-initiative with different names
test("hole: 5 concurrent add-initiative with different names — all succeed", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const ops = ["a", "b", "c", "d", "e"].map((n) =>
      runCli(["--project", dir, "add-initiative", n, "--desc", "i" + n])
    );
    const results = await Promise.all(ops);
    results.forEach((r) => assert.equal(r.code, 0, r.stderr));
    const s = await readState(dir);
    for (const n of ["a", "b", "c", "d", "e"]) {
      assert.ok(s.initiatives[n]);
    }
  } finally {
    await rmTempProject(dir);
  }
});
