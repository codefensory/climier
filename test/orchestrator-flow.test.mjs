// Orchestrator flow: simulate an orchestrator + 3 workers running in parallel.
// All output is JSON to stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli, readState } from "./helpers.mjs";

test("orchestrator flow: init seed, delegate, 3 workers complete tasks in parallel, decide decision, dependents unblock", async () => {
  const dir = await createTempProject();
  try {
    // 1. Init with migration seed.
    let r = await runCli(["--project", dir, "init", "--seed", "migration"]);
    assert.equal(r.code, 0, r.stderr);

    // 2. Orchestrator reads status; expects a few ready tasks.
    r = await runCli(["--project", dir, "ready"]);
    assert.equal(r.code, 0, r.stderr);
    const readyData = JSON.parse(r.stdout);
    assert.ok(readyData.some((t) => /^F[01]\.T\d$/.test(t.id)));

    // 3. Orchestrator reads blocked-by-decision and decides D1.
    r = await runCli(["--project", dir, "status"]);
    const statusData = JSON.parse(r.stdout);
    assert.ok(statusData.open_decisions.includes("D1"));
    r = await runCli(["--project", dir, "decide", "D1", "raw-postgres", "--because", "skip Directus"]);
    assert.equal(r.code, 0, r.stderr);

    // 4. 2 workers claim 2 different tasks in parallel and complete them.
    // F0.T1 is the only initially-ready task. Two-phase: claim F0.T1, do it,
    // then F0.T2 becomes ready and the other worker claims it.
    const phase1 = await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-ts"]);
    if (phase1.code !== 0) console.error("phase1 stderr:", phase1.stderr, "stdout:", phase1.stdout);
    assert.equal(phase1.code, 0, `phase1 failed: ${phase1.stderr}`);

    const done1 = await runCli(["--project", dir, "done", "F0.T1", "monorepo up", "--as", "agent-ts"]);
    assert.equal(done1.code, 0, done1.stderr);

    // Now F0.T2 (depends on F0.T1) and F0.T4 (depends on F0.T1) are both ready.
    const c2 = runCli(["--project", dir, "claim", "F0.T2", "--as", "agent-zod"]);
    const c4 = runCli(["--project", dir, "claim", "F0.T4", "--as", "agent-shared"]);
    const [r2, r4] = await Promise.all([c2, c4]);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r4.code, 0, r4.stderr);

    const d2 = await runCli(["--project", dir, "done", "F0.T2", "api up", "--as", "agent-zod"]);
    const d4 = await runCli(["--project", dir, "done", "F0.T4", "shared up", "--as", "agent-shared"]);
    assert.equal(d2.code, 0, d2.stderr);
    assert.equal(d4.code, 0, d4.stderr);

    // 5. State should be consistent.
    const s = await readState(dir);
    for (const t of ["F0.T1", "F0.T2", "F0.T4"]) {
      assert.equal(s.tasks[t].status, "done", `${t} should be done`);
    }
    assert.equal(s.decisions.D1.status, "decided");
    assert.ok(s.log.length >= 1 + 3 * 2); // 1 decide + 3 claims + 3 dones
  } finally {
    await rmTempProject(dir);
  }
});

test("orchestrator flow: a task depending only on a decision becomes ready after decide", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    // Manually set up: a decision D1 and a task that depends only on D1.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    const state = {
      version: 1,
      tasks: { "X.1": { id: "X.1", title: "blocked by D1" } },
      decisions: { D1: { id: "D1", title: "choice" } },
      gotchas: {},
      initiatives: { x: { desc: "" } },
      log: [],
    };
    state.tasks["X.1"].depends_on = ["D1"];
    await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n");

    let r = await runCli(["--project", dir, "ready"]);
    assert.equal(r.code, 0, r.stderr);
    const readyBefore = JSON.parse(r.stdout);
    assert.deepEqual(readyBefore, []);

    r = await runCli(["--project", dir, "decide", "D1", "yes", "--because", "ok"]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["--project", dir, "ready"]);
    const readyAfter = JSON.parse(r.stdout);
    assert.ok(readyAfter.some((t) => t.id === "X.1"));
  } finally {
    await rmTempProject(dir);
  }
});
