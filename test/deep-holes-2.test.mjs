// Deep holes — round 2: concurrency, atomicity, edge cases
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// #33: log entry should be in the SAME atomic write as the state change.
// Verify by counting the gap between mutation and log; under high contention,
// the count of "claim" log entries should equal the count of "status: in_progress".
test("hole: log entries are atomic with state mutations (claim + log counted match)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    // Fire 10 parallel claim/release cycles
    const ops = Array.from({ length: 10 }, (_, i) => (async () => {
      const c = await runCli(["--project", dir, "claim", "F0.T1", "--as", `agent-${i}`]);
      // Whoever wins does done
      if (c.code === 0) {
        await runCli(["--project", dir, "done", "F0.T1", "ok", "--as", `agent-${i}`]);
      }
    })());
    await Promise.all(ops);
    const s = await readState(dir);
    const claimLogs = s.log.filter((e) => e.action === "claim");
    const doneLogs = s.log.filter((e) => e.action === "done");
    // Every successful claim should have a matching log; no log should be lost.
    // At minimum, we should see at least one claim log.
    assert.ok(claimLogs.length >= 1, "no claim log entries");
    // And the count of done logs should equal the count of successful claims.
    // We can't directly count successful claims, but claim and done should be paired 1:1.
    assert.equal(claimLogs.length, doneLogs.length, "claim and done logs out of sync");
  } finally {
    await rmTempProject(dir);
  }
});

// #30: rapid sequential updates from the same process do not collide on tmp filename.
test("hole: rapid sequential updateState from same process do not collide on tmp filename", async () => {
  const { updateState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks = { T1: { id: "T1", title: "v1" } };
      return s;
    });
    // 50 rapid updates
    for (let i = 0; i < 50; i++) {
      await updateState(dir, (s) => {
        s.tasks.T1.title = `v${i}`;
        return s;
      });
    }
    const s = await readState(dir);
    assert.equal(s.tasks.T1.title, "v49");
  } finally {
    await rmTempProject(dir);
  }
});

// #addNode: should also be lock-aware
test("hole: addNode uses withLock so concurrent addNode calls don't corrupt", async () => {
  const { addNode } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const addMany = Array.from({ length: 10 }, (_, i) =>
      addNode(dir, "tasks", `T${i}`, { id: `T${i}`, title: `task ${i}` })
    );
    await Promise.all(addMany);
    const s = await readState(dir);
    for (let i = 0; i < 10; i++) {
      assert.ok(s.tasks[`T${i}`], `T${i} missing`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

// A task with no `status` field is treated as "ready" if no deps. Verify edge.
test("hole: a task with no status field and no deps is ready", async () => {
  const { derive, statusOf } = await importFresh("./dag.mjs");
  const state = { tasks: { T1: { id: "T1" } }, decisions: {} };
  assert.equal(statusOf(state, "T1"), "ready");
  assert.deepEqual(derive(state).ready, ["T1"]);
});

// A task with a future status (e.g. "frozen") should be treated as ready for derive purposes.
// (This is a defensive test; if someone adds a new status, derive shouldn't crash.)
test("hole: a task with an unknown persisted status is still derived correctly", async () => {
  const { derive, statusOf } = await importFresh("./dag.mjs");
  const state = { tasks: { T1: { id: "T1", status: "future-state" } }, decisions: {} };
  // status is not done/skipped/in_progress, so derive treats it as candidate
  const r = derive(state);
  assert.deepEqual(r.ready, ["T1"]);
  assert.equal(statusOf(state, "T1"), "ready");
});

// init with a corrupt state: behavior depends on the situation.
// If the file exists and is valid, --force is required.
// If the file is corrupt, init auto-recovers (this is a deliberate recovery path).
test("hole: init without --force over a valid state file refuses", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] }), "utf8");
    await assert.rejects(
      init({ statePath: dir, flags: {}, positional: [], projectDir: dir }),
      /already exists|use --force/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("hole: init --force over a corrupt state file succeeds and produces a clean state", async () => {
  const { default: init } = await importFresh("./commands/init.mjs");
  const dir = await createTempProject();
  try {
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, "{ broken json", "utf8");
    await init({ statePath: dir, flags: { force: true }, positional: [], projectDir: dir });
    const s = await readState(dir);
    assert.deepEqual(s.tasks, {});
    assert.equal(s.version, 1);
  } finally {
    await rmTempProject(dir);
  }
});

// next with a task that has no acceptance / definition should not crash
test("hole: next on a minimal task (no title) returns placeholders", async () => {
  const { default: next } = await importFresh("./commands/next.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    const out = await next({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.match(out.definition, /no definition/i);
    assert.match(out.acceptance, /no acceptance/i);
  } finally {
    await rmTempProject(dir);
  }
});

// Claim a task that is in_progress but with claimed_by different — explicit error message
test("hole: claim on already-claimed task shows the claimer name in error", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice" };
      return s;
    });
    try {
      await claim({ statePath: dir, flags: { as: "bob" }, positional: ["T1"] });
      assert.fail("expected reject");
    } catch (err) {
      assert.match(err.message, /alice/);
    }
  } finally {
    await rmTempProject(dir);
  }
});

// Multiple add-initiative calls with --force-like behavior (overwrite desc) — already tested.
// Add: get all known decisions via a hypothetical read; verify the seed has 4.
test("hole: derive includes all 4 open decisions from the migration seed", async () => {
  const { migrationSeed } = await import("../src/seeds/migration.mjs");
  const { derive } = await importFresh("./dag.mjs");
  const r = derive(migrationSeed);
  assert.equal(r.openDecisions.length, 4);
  assert.deepEqual(r.openDecisions.sort(), ["D1", "D2", "D3", "D4"]);
});

// Concurrent: 5 different agents each claim a different task from ready set
test("hole: 5 different agents claim 5 different ready tasks in parallel — all succeed", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // Seed 5 independent tasks directly
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    const seed = {
      version: 1,
      tasks: {
        "A.1": { id: "A.1" }, "A.2": { id: "A.2" }, "A.3": { id: "A.3" },
        "A.4": { id: "A.4" }, "A.5": { id: "A.5" },
      },
      decisions: {}, gotchas: {}, initiatives: { x: { desc: "" } }, log: [],
    };
    await fs.writeFile(file, JSON.stringify(seed, null, 2) + "\n");
    const claims = ["A.1", "A.2", "A.3", "A.4", "A.5"].map((t, i) =>
      runCli(["--project", dir, "claim", t, "--as", `agent-${i}`])
    );
    const results = await Promise.all(claims);
    results.forEach((r, i) => {
      assert.equal(r.code, 0, `agent-${i} failed: ${r.stderr}`);
    });
    const s = await readState(dir);
    for (const t of ["A.1", "A.2", "A.3", "A.4", "A.5"]) {
      assert.equal(s.tasks[t].status, "in_progress", `${t} not in_progress`);
    }
  } finally {
    await rmTempProject(dir);
  }
});
