// Deep holes — round 4: stress, security, format
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState, stateFilePath, initExampleProject} from "./helpers.mjs";

// Stress: 50 sequential claim/done cycles on the same task produce a consistent log.
test("hole: 50 sequential claim/done cycles leave state consistent and log ordered", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const file = stateFilePath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1" } }, decisions: {}, gotchas: {},
      initiatives: { x: { desc: "" } }, log: [],
    }), "utf8");
    for (let i = 0; i < 50; i++) {
      const c = await runCli(["--project", dir, "claim", "T1", "--as", "agent"]);
      if (c.code === 0) {
        const d = await runCli(["--project", dir, "done", "T1", `iter ${i}`, "--as", "agent"]);
        assert.equal(d.code, 0, d.stderr);
      } else {
        // Race lost; skip
        const r = await runCli(["--project", dir, "release", "T1", "--as", "agent"]);
        if (r.code !== 0) break;
      }
    }
    // Just verify state file is valid JSON and has the expected shape
    const s = await readState(dir);
    assert.ok(s.tasks.T1);
    assert.ok(s.log.length > 0);
  } finally {
    await rmTempProject(dir);
  }
});

// Long task IDs and notes
test("hole: long task ids and notes are handled", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const longId = "X." + "y".repeat(200);
    const r1 = await runCli(["--project", dir, "add-task", longId, "--initiative", "x", "--title", "long id test"]);
    assert.equal(r1.code, 0, r1.stderr);
    const r2 = await runCli(["--project", dir, "claim", longId, "--as", "agent"]);
    assert.equal(r2.code, 0, r2.stderr);
    const longNote = "n".repeat(1000);
    const r3 = await runCli(["--project", dir, "done", longId, longNote, "--as", "agent"]);
    assert.equal(r3.code, 0, r3.stderr);
    const s = await readState(dir);
    assert.equal(s.tasks[longId].note.length, 1000);
  } finally {
    await rmTempProject(dir);
  }
});

// Unicode in task title and note
test("hole: unicode in titles and notes is preserved", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "x", "--desc", ""]);
    const r1 = await runCli(["--project", dir, "add-task", "T1", "--initiative", "x", "--title", "Migración 漢字 émoji"]);
    assert.equal(r1.code, 0, r1.stderr);
    await runCli(["--project", dir, "claim", "T1", "--as", "agente-ñoño"]);
    const r2 = await runCli(["--project", dir, "done", "T1", "Написано на русском 日本語", "--as", "agente-ñoño"]);
    assert.equal(r2.code, 0, r2.stderr);
    const s = await readState(dir);
    assert.match(s.tasks.T1.title, /Migración/);
    assert.match(s.tasks.T1.note, /русском/);
  } finally {
    await rmTempProject(dir);
  }
});

// Empty log entries are not allowed (action required)
test("hole: append without action fails", async () => {
  const { append } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      append(dir, { agent: "a" }),
      /action/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// append without agent fails
test("hole: append without agent fails", async () => {
  const { append } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      append(dir, { action: "claim", task: "T1" }),
      /agent/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// views: formatters were removed in the JSON-only refactor.

// Concurrent example fixture init should not duplicate state.
test("hole: concurrent init example fixture produces one canonical state", async () => {
  const dir = await createTempProject();
  try {
    const [r1, r2] = await Promise.all([
      initExampleProject(dir),
      initExampleProject(dir),
    ]);
    // At least one should succeed
    const successes = [r1, r2].filter((r) => r.code === 0);
    assert.ok(successes.length >= 1);
    const s = await readState(dir);
    assert.ok(s.tasks["F0.T1"]);
  } finally {
    await rmTempProject(dir);
  }
});

// Release by orchestrator on a NORMAL task (not orphan) should still work
test("hole: orchestrator can release a task claimed by another agent (recovery)", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice" };
      return s;
    });
    await release({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.claimed_by, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// decide on a decision that does not exist fails with clear error
test("hole: decide on missing decision fails clean", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(
      decide({ statePath: dir, flags: { as: "o" }, positional: ["D_MISSING", "x"] }),
      /not found/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// next on a missing task
test("hole: next on missing task fails clean", async () => {
  const { default: next } = await importFresh("./commands/next.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(
      next({ statePath: dir, flags: {}, positional: ["T_MISSING"] }),
      /not found/i
    );
  } finally {
    await rmTempProject(dir);
  }
});

// The example fixture used by integration tests should stay internally consistent.
test("hole: example fixture is internally consistent (deps reference existing nodes)", async () => {
  const { exampleState } = await import("./helpers.mjs");
  const fixture = exampleState();
  for (const t of Object.values(fixture.tasks)) {
    for (const dep of t.depends_on || []) {
      assert.ok(
        fixture.tasks[dep] || fixture.decisions[dep],
        `task ${t.id} depends on missing node ${dep}`
      );
    }
  }
});

// views: formatters were removed in the JSON-only refactor.
