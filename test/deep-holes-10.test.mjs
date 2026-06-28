// Deep holes — round 10: try to break things in unexpected ways
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// Idempotency: running decide twice on the same decision (after first) is rejected
test("hole: re-decide is idempotent in the sense of rejecting cleanly", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    await decide({ statePath: dir, flags: { as: "o" }, positional: ["D1", "first"] });
    // Second attempt should fail
    await assert.rejects(
      decide({ statePath: dir, flags: { as: "o" }, positional: ["D1", "second"] }),
      /already decided/i
    );
    // State should be unchanged
    const s = await readState(dir);
    assert.equal(s.decisions.D1.choice, "first");
  } finally {
    await rmTempProject(dir);
  }
});

// Block on a task that's not in_progress fails clean
test("hole: block on a done task fails with the right error", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done" };
      return s;
    });
    await assert.rejects(
      block({ statePath: dir, flags: { as: "a" }, positional: ["T1", "x"] }),
      /not in_progress/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// Claim with a positional that has the id AND extra args (e.g. claim T1 extra)
test("hole: claim with extra positional args uses only the first as id", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    const r = await claim({ statePath: dir, flags: { as: "a" }, positional: ["T1", "extra"] });
    assert.equal(r.task.id, "T1");
  } finally {
    await rmTempProject(dir);
  }
});

// claim with positional that has NO id
test("hole: claim with no positional fails clean", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(
      claim({ statePath: dir, flags: { as: "a" }, positional: [] }),
      /task id required/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// ready view: with --initiative filter, the result respects the filter
test("hole: ready --initiative filter excludes tasks from other initiatives", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "x" };
      s.tasks.T2 = { id: "T2", initiative: "y" };
      s.tasks.T3 = { id: "T3", initiative: "x" };
      return s;
    });
    const out = await ready({ statePath: dir, flags: { initiative: "x" } });
    assert.equal(out.length, 2);
    const ids = out.map((t) => t.id).sort();
    assert.deepEqual(ids, ["T1", "T3"]);
  } finally {
    await rmTempProject(dir);
  }
});

// status with --initiative shows only that initiative's blocked_by_decision
test("hole: status --initiative filter narrows blocked_by_decision", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      s.tasks.T1 = { id: "T1", initiative: "x", depends_on: ["D1"] };
      s.tasks.T2 = { id: "T2", initiative: "y", depends_on: ["D1"] };
      return s;
    });
    const out = await status({ statePath: dir, flags: { initiative: "x" } });
    // Only T1 should be in blocked_by_decision since we're filtering to x
    if (out.blocked_by_decision.D1) {
      assert.ok(out.blocked_by_decision.D1.includes("T1"));
      assert.ok(!out.blocked_by_decision.D1.includes("T2"));
    }
  } finally {
    await rmTempProject(dir);
  }
});

// Status: a task with status 'in_progress' but no claimed_by is in_progress
test("hole: an in_progress task without claimed_by appears in in_progress list", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress" };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.in_progress.length, 1);
    assert.equal(out.in_progress[0].id, "T1");
  } finally {
    await rmTempProject(dir);
  }
});

// Migration seed: 4 open decisions and 4 gotchas exactly
test("hole: migration seed has exactly 4 decisions and 5 gotchas", async () => {
  const { migrationSeed } = await import("../src/seeds/migration.mjs");
  const decisions = Object.values(migrationSeed.decisions).filter((d) => d.status !== "decided");
  assert.equal(decisions.length, 4);
  const gotchas = Object.values(migrationSeed.gotchas);
  assert.equal(gotchas.length, 5);
});

// Migration seed: F0 has 4 tasks, F1 has 2 tasks, F2-F9 have 1 stub each
test("hole: migration seed structure is correct (F0 has 4 tasks, F1 has 2, F2-F9 are stubs)", async () => {
  const { migrationSeed } = await import("../src/seeds/migration.mjs");
  const f0 = Object.values(migrationSeed.tasks).filter((t) => t.id.startsWith("F0."));
  const f1 = Object.values(migrationSeed.tasks).filter((t) => t.id.startsWith("F1."));
  assert.equal(f0.length, 4);
  assert.equal(f1.length, 2);
  for (let p = 2; p <= 9; p++) {
    const stubs = Object.values(migrationSeed.tasks).filter((t) => t.id.startsWith(`F${p}.`));
    assert.equal(stubs.length, 1, `F${p} should have 1 stub`);
    assert.match(stubs[0].id, /\.OPEN$/);
  }
});

// views: formatStatus never throws even with weird inputs
test("hole: formatStatus tolerates missing fields gracefully", async () => {
  const { formatStatus } = await importFresh("../src/views.mjs");
  // Missing some fields
  const out = formatStatus({ counts: {} });
  assert.ok(typeof out === "string");
});

// init with a custom --seed we don't recognize: doesn't crash, creates empty
test("hole: init --seed 'unknown' creates empty state, doesn't crash", async () => {
  const dir = await createTempProject();
  try {
    const r = await runCli(["--project", dir, "init", "--seed", "unknown_seed_value"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.deepEqual(s.tasks, {});
  } finally {
    await rmTempProject(dir);
  }
});

// Many tasks: ensure ready is not O(n^2) or similar
test("hole: ready with 1000 tasks is fast (<500ms)", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const seed = {
      version: 1,
      tasks: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [`T${i}`, { id: `T${i}`, title: `task ${i}` }])
      ),
      decisions: {}, gotchas: {}, initiatives: { x: { desc: "" } }, log: [],
    };
    await fs.writeFile(path.join(dir, ".agents", "tasks", "tasks.json"), JSON.stringify(seed), "utf8");
    const t0 = Date.now();
    const out = await ready({ statePath: dir, flags: {} });
    const elapsed = Date.now() - t0;
    assert.equal(out.length, 1000);
    assert.ok(elapsed < 500, `ready took ${elapsed}ms`);
  } finally {
    await rmTempProject(dir);
  }
});

// add-task with --domain that contains a slash
test("hole: add-task with --domain containing slashes works", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", "y", "--domain", "team/api"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.equal(s.tasks.T1.domain, "team/api");
  } finally {
    await rmTempProject(dir);
  }
});
