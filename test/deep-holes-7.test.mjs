// Deep holes — round 7: looking for things I noted but never tested
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// addNode with duplicate id should fail
test("hole: addNode with duplicate id fails", async () => {
  const { addNode } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addNode(dir, "tasks", "T1", { id: "T1", title: "first" });
    await assert.rejects(
      addNode(dir, "tasks", "T1", { id: "T1", title: "second" }),
      /already exists/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// addNode on decisions
test("hole: addNode on decisions collection works", async () => {
  const { addNode } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addNode(dir, "decisions", "D1", { id: "D1", title: "big choice" });
    const s = await readState(dir);
    assert.ok(s.decisions.D1);
  } finally {
    await rmTempProject(dir);
  }
});

// addNode on gotchas
test("hole: addNode on gotchas collection works", async () => {
  const { addNode } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await addNode(dir, "gotchas", "G1", { id: "G1", title: "trap", applies_to: ["domain:db"] });
    const s = await readState(dir);
    assert.ok(s.gotchas.G1);
  } finally {
    await rmTempProject(dir);
  }
});

// A task with effort "m" should still appear in ready (effort is just metadata)
test("hole: tasks with various effort values are queryable", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", effort: "s" };
      s.tasks.T2 = { id: "T2", effort: "m" };
      s.tasks.T3 = { id: "T3", effort: "l" };
      s.tasks.T4 = { id: "T4" }; // no effort
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    assert.equal(out.length, 4);
  } finally {
    await rmTempProject(dir);
  }
});

// Block by an agent that is NOT the owner but IS the orchestrator — should this work?
// (Per current implementation, only the owner can block. That's a policy choice.)
test("hole: only the claim owner can block (orchestrator cannot block on behalf)", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice" };
      return s;
    });
    await assert.rejects(
      block({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1", "stuck"] }),
      /not yours|not owner/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// A task in_progress with no claimed_at (corruption): status is still 'in_progress' for the JSON
test("hole: stale detection does not crash on in_progress with no claimed_at", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "a" }; // no claimed_at
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    // No crash, no stale entry (claimed_at is required for stale detection)
    assert.equal(out.stale.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

// Format task short: removed (formatters dropped in JSON-only refactor).

// Many concurrent ops: 100 different ops on 100 different tasks
test("hole: 100 parallel claims on 100 different tasks — all succeed", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const seed = {
      version: 1,
      tasks: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`T${i}`, { id: `T${i}` }])),
      decisions: {}, gotchas: {}, initiatives: { x: { desc: "" } }, log: [],
    };
    await fs.writeFile(path.join(dir, ".agents", "tasks", "tasks.json"), JSON.stringify(seed), "utf8");
    const claims = Array.from({ length: 100 }, (_, i) =>
      runCli(["--project", dir, "claim", `T${i}`, "--as", `agent-${i}`])
    );
    const results = await Promise.all(claims);
    const ok = results.filter((r) => r.code === 0);
    assert.equal(ok.length, 100);
  } finally {
    await rmTempProject(dir);
  }
});

// decide appends to log with both choice and because in note
test("hole: decide logs choice + rationale correctly", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    await decide({ statePath: dir, flags: { as: "orch", because: "less complexity" }, positional: ["D1", "raw-postgres"] });
    const s = await readState(dir);
    const log = s.log.find((e) => e.action === "decide" && e.decision === "D1");
    assert.ok(log);
    assert.match(log.note, /raw-postgres/);
    assert.match(log.note, /less complexity/);
  } finally {
    await rmTempProject(dir);
  }
});

// decide without --because works
test("hole: decide without --because still works", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    const r = await decide({ statePath: dir, flags: {}, positional: ["D1", "go"] });
    assert.equal(r.decision.choice, "go");
    assert.equal(r.decision.rationale, "");
  } finally {
    await rmTempProject(dir);
  }
});

// A readState on a file that is actually a directory should fail clean
test("hole: readState on a path that's a directory fails clean", async () => {
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    // Remove tasks.json and replace with a directory
    await fs.rm(path.join(dir, ".agents", "tasks", "tasks.json"), { force: true });
    await fs.mkdir(path.join(dir, ".agents", "tasks", "tasks.json"));
    await assert.rejects(readState(dir), /state:|corrupt|invalid|is a directory|EISDIR/i);
  } finally {
    await rmTempProject(dir);
  }
});

// add-task --skills with empty string
test("hole: add-task --skills '' produces empty skills array", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    await runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", "y", "--skills", ""]);
    const s = await readState(dir);
    assert.deepEqual(s.tasks.T1.skills, []);
  } finally {
    await rmTempProject(dir);
  }
});
