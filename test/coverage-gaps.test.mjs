// Coverage gaps from the audit. These are missing test scenarios.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState, stateFilePath } from "./helpers.mjs";

// GAP: claim before init — should fail cleanly.
test("coverage: claim before init fails with a clear error", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      claim({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /state.*missing|init/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: status, tasks, graph, ready all return safely when state is missing.
test("coverage: status on empty project returns a friendly empty object", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const out = await status({ statePath: dir, flags: {} });
    assert.deepEqual(out.counts, {});
    assert.deepEqual(out.in_progress, []);
    assert.deepEqual(out.ready, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("coverage: ready on empty project returns empty list", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const out = await ready({ statePath: dir, flags: {} });
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("coverage: tasks on empty project returns empty list", async () => {
  const { default: tasks } = await importFresh("./commands/tasks.mjs");
  const dir = await createTempProject();
  try {
    const out = await tasks({ statePath: dir, flags: {} });
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

test("coverage: graph on empty project returns empty list (caller handles 'no state' message)", async () => {
  const { default: graph } = await importFresh("./commands/graph.mjs");
  const dir = await createTempProject();
  try {
    const out = await graph({ statePath: dir, flags: {} });
    assert.deepEqual(out, []);
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: block_reason is cleared by done and by release.
test("coverage: done clears block_reason", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a", block_reason: "old reason" };
      return s;
    });
    await done({ statePath: dir, flags: { as: "a" }, positional: ["T1", "ok"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.block_reason, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("coverage: release clears block_reason", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a", block_reason: "x" };
      return s;
    });
    await release({ statePath: dir, flags: { as: "a" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.block_reason, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: same agent claims the same task 5x in parallel — exactly one wins.
test("coverage: same agent parallel claim of same task — exactly one wins", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    const claims = Array.from({ length: 5 }, () =>
      claim({ statePath: dir, flags: { as: "agent-x" }, positional: ["T1"] })
    );
    const results = await Promise.allSettled(claims);
    const ok = results.filter((r) => r.status === "fulfilled");
    const fail = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 4);
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: claim → block → done works (a task that hit a blocker and is now done).
test("coverage: claim → block → done sequence works end-to-end", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const { default: block } = await importFresh("./commands/block.mjs");
  const { default: done } = await importFresh("./commands/done.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await claim({ statePath: dir, flags: { as: "a" }, positional: ["T1"] });
    await block({ statePath: dir, flags: { as: "a" }, positional: ["T1", "need more info"] });
    let s = await readState(dir);
    assert.match(s.tasks.T1.block_reason, /need more info/);
    await done({ statePath: dir, flags: { as: "a" }, positional: ["T1", "got the info, done"] });
    s = await readState(dir);
    assert.equal(s.tasks.T1.status, "done");
    assert.equal(s.tasks.T1.block_reason, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: claim → block → release works (worker hits blocker, releases for someone else).
test("coverage: claim → block → release sequence works end-to-end", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const { default: block } = await importFresh("./commands/block.mjs");
  const { default: release } = await importFresh("./commands/release.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await claim({ statePath: dir, flags: { as: "a" }, positional: ["T1"] });
    await block({ statePath: dir, flags: { as: "a" }, positional: ["T1", "stuck"] });
    await release({ statePath: dir, flags: { as: "a" }, positional: ["T1"] });
    const s = await readState(dir);
    // Back to ready (no status field persisted)
    assert.equal(s.tasks.T1.status, undefined);
    assert.equal(s.tasks.T1.claimed_by, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: CLI with cwd (no --project) uses CWD.
test("coverage: CLI defaults to CWD when --project is omitted", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["init"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const exists = await fs.access(stateFilePath(dir)).then(() => true).catch(() => false);
    assert.equal(exists, true);
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: stale detection via CLI flag --staleMs.
test("coverage: status --staleMs flag affects stale detection", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a", claimed_at: Date.now() - 60_000 };
      return s;
    });
    const out1 = await status({ statePath: dir, flags: { staleMs: "120000" } }); // 2 min
    assert.equal(out1.stale.length, 0);
    const out2 = await status({ statePath: dir, flags: { staleMs: "30000" } }); // 30s
    assert.equal(out2.stale.length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: add-initiative over an existing initiative updates desc (or fails — document the behavior).
test("coverage: add-initiative updates description if initiative already exists", async () => {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addInit({ statePath: dir, flags: { desc: "first" }, positional: ["mig"] });
    await addInit({ statePath: dir, flags: { desc: "second" }, positional: ["mig"] });
    const s = await readState(dir);
    assert.equal(s.initiatives.mig.desc, "second");
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: decide twice — second is rejected.
test("coverage: decide on an already-decided decision is rejected", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    await decide({ statePath: dir, flags: { as: "o" }, positional: ["D1", "x", "y"] });
    await assert.rejects(
      decide({ statePath: dir, flags: { as: "o" }, positional: ["D1", "x2", "y2"] }),
      /already decided/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// GAP: done on a task in_progress but with claimed_by undefined (orphaned) fails cleanly.
test("coverage: done on an orphaned in_progress task fails with clear error", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress" }; // no claimed_by — orphaned
      return s;
    });
    await assert.rejects(
      done({ statePath: dir, flags: { as: "anyone" }, positional: ["T1", "n"] }),
      /yours|owner|undefined/i
    );
  } finally {
    await rmTempProject(dir);
  }
});
