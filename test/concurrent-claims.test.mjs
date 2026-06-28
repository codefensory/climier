// Multi-agent concurrency: two processes claim the same task; only one wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli, readState } from "./helpers.mjs";

test("concurrent: two agents claim the same task simultaneously, exactly one wins", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);

    // F0.T1 has no deps; safe to claim without first doing F0.x.
    const a = runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-A"]);
    const b = runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-B"]);
    const [resA, resB] = await Promise.all([a, b]);

    const successes = [resA, resB].filter((r) => r.code === 0);
    const failures = [resA, resB].filter((r) => r.code !== 0);
    assert.equal(successes.length, 1, `expected exactly 1 success, got: A=${resA.code} B=${resB.code}; stderr: A=${resA.stderr} B=${resB.stderr}`);
    assert.equal(failures.length, 1);

    const s = await readState(dir);
    assert.equal(s.tasks["F0.T1"].status, "in_progress");
    assert.ok(s.tasks["F0.T1"].claimed_by);
    assert.ok(["agent-A", "agent-B"].includes(s.tasks["F0.T1"].claimed_by));
  } finally {
    await rmTempProject(dir);
  }
});

test("concurrent: two agents claim different tasks in parallel, both succeed", async () => {
  const dir = await createTempProject();
  try {
    // Seed two independent ready tasks directly via the state file.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    const state = {
      version: 1,
      tasks: {
        "A.1": { id: "A.1", initiative: "x", title: "first" },
        "A.2": { id: "A.2", initiative: "x", title: "second" },
      },
      decisions: {},
      gotchas: {},
      initiatives: { x: { desc: "" } },
      log: [],
    };
    await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n");

    const a = runCli(["--project", dir, "claim", "A.1", "--as", "agent-1"]);
    const b = runCli(["--project", dir, "claim", "A.2", "--as", "agent-2"]);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
    const s = await readState(dir);
    assert.equal(s.tasks["A.1"].claimed_by, "agent-1");
    assert.equal(s.tasks["A.2"].claimed_by, "agent-2");
  } finally {
    await rmTempProject(dir);
  }
});

test("concurrent: rapid claim/release sequence leaves state consistent (5 cycles on F0.T1)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    // Cycle: claim, release, claim, release — task should remain not in_progress
    // and log should accumulate 5 claim + 5 release entries.
    for (let i = 0; i < 5; i++) {
      const c = await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-1"]);
      assert.equal(c.code, 0, c.stderr);
      const r = await runCli(["--project", dir, "release", "F0.T1", "--as", "agent-1"]);
      assert.equal(r.code, 0, r.stderr);
    }
    const s = await readState(dir);
    assert.equal(s.tasks["F0.T1"].status, undefined); // back to ready (derived)
    assert.equal(s.log.filter((e) => e.action === "claim").length, 5);
    assert.equal(s.log.filter((e) => e.action === "release").length, 5);
  } finally {
    await rmTempProject(dir);
  }
});
