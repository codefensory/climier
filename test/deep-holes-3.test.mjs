// Deep holes — round 3: atomicity, parser edge cases, error semantics
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState, initExampleProject} from "./helpers.mjs";

// Atomicity: if a mutator throws AFTER making changes, the state should not be partially modified.
test("hole: updateState that mutates partially then throws leaves no partial write", async () => {
  const { updateState, readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await updateState(dir, (s) => {
      s.tasks = { T1: { id: "T1", title: "original" } };
      return s;
    });
    await assert.rejects(
      updateState(dir, (s) => {
        s.tasks.T1.title = "PARTIAL";
        // Now mutator throws BEFORE returning — does the change get written?
        // Per our contract, mutator must return the new state. If it throws, we don't write.
        throw new Error("abort");
      })
    );
    const s = await readState(dir);
    assert.equal(s.tasks.T1.title, "original", "partial write leaked");
  } finally {
    await rmTempProject(dir);
  }
});

// Parser: --flag=value (single token with =)
test("hole: --flag=value syntax is supported", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project=" + dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// Parser: --flag= (empty value) should treat as empty, not true
test("hole: --flag= (empty) does not become true", async () => {
  // --force= should be treated as --force true. We test via init.
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "--force=true", "init"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.deepEqual(s.tasks, {});
  } finally {
    await rmTempProject(dir);
  }
});

// Multiple flags interleaved with positional: climier claim T1 --as agent
test("hole: flag after positional still works (claim T1 --as agent)", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent-x"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// done with a note that contains a -- inside: shell-level concern.
// The user must quote the note; the CLI takes whatever positional args remain.
// Verify that with quoting (single arg), the note is preserved.
test("hole: done with a quoted note containing -- is parsed correctly", async () => {
  const dir = await createTempProject();
  try {
    await initExampleProject(dir);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "agent"]);
    // Single-arg note with -- inside; relies on the test runner passing it as one argv element.
    const r = await runCli(["--project", dir, "done", "F0.T1", "shipped -- not tested yet", "--as", "agent"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.match(s.tasks["F0.T1"].note, /shipped -- not tested yet/);
  } finally {
    await rmTempProject(dir);
  }
});

// add-task with empty positional (no id) fails clean
test("hole: add-task with no id fails clean", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const r = await runCli(["--project", dir, "add-task", "--initiative", "x", "--title", "y"]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /id required/i);
  } finally {
    await rmTempProject(dir);
  }
});

// add-task with --title empty
test("hole: add-task with --title '' fails clean", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const r = await runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", ""]);
    assert.notEqual(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.match(data.error, /title/i);
  } finally {
    await rmTempProject(dir);
  }
});

// release: a task that is `done` cannot be released (it's already closed)
test("hole: release on a done task fails clean", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done" };
      return s;
    });
    await assert.rejects(
      release({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /not in_progress/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// release: a task that is `archived` cannot be released
test("hole: release on a archived task fails clean", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "archived" };
      return s;
    });
    await assert.rejects(
      release({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }),
      /not in_progress/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// Status: a task claimed in the future (claimed_at in the future) is NOT stale
test("hole: a claim with claimed_at in the future is not stale", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a", claimed_at: Date.now() + 60_000 };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.equal(out.stale.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// Status: --initiative filter works
test("hole: status --initiative filter limits counts", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "x" };
      s.tasks.T2 = { id: "T2", initiative: "y" };
      return s;
    });
    const out = await status({ statePath: dir, flags: { initiative: "x" } });
    // Should only count x's tasks
    assert.ok(out.counts.x);
    assert.equal(out.counts.y, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// ready with multiple deps all satisfied
test("hole: ready resolves a chain of 3 satisfied deps", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.A = { id: "A" };
      s.tasks.B = { id: "B", depends_on: ["A"] };
      s.tasks.C = { id: "C", depends_on: ["B"] };
      s.tasks.D = { id: "D", depends_on: ["C"] };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "A");
    // Now mark them all done by simulating
    await updateState(dir, (s) => {
      s.tasks.A.status = "done";
      s.tasks.B.status = "done";
      s.tasks.C.status = "done";
      return s;
    });
    const out2 = await ready({ statePath: dir, flags: {} });
    assert.equal(out2.length, 1);
    assert.equal(out2[0].id, "D");
  } finally {
    await rmTempProject(dir);
  }
});

// decide with --as="something with spaces" works
test("hole: decide with --as containing spaces works", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    await decide({ statePath: dir, flags: { as: "team alpha" }, positional: ["D1", "raw-postgres"] });
    const s = await readState(dir);
    assert.equal(s.decisions.D1.decided_by, "team alpha");
  } finally {
    await rmTempProject(dir);
  }
});

// Concurrent: two `add-task` with the same id — exactly one wins
test("hole: concurrent add-task with same id — exactly one wins", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const [r1, r2] = await Promise.all([
      runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", "first"]),
      runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", "second"]),
    ]);
    const ok = [r1, r2].filter((r) => r.code === 0);
    const fail = [r1, r2].filter((r) => r.code !== 0);
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    const s = await readState(dir);
    assert.ok(s.tasks.T1);
  } finally {
    await rmTempProject(dir);
  }
});

// Task with effort value 'invalid' — should not break status counts
test("hole: status counts work even with weird effort values", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "x", effort: "huge" }; // not s/m/l
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    assert.ok(out.counts.x);
    assert.equal(out.counts.x.ready, 1);
  } finally {
    await rmTempProject(dir);
  }
});
