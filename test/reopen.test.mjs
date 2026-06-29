// reopen: roll back a done task to in_progress, with a reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

async function setupDone(dir, id = "T1", doneBy = "agent-a") {
  const { updateState } = await importFresh("./state.mjs");
  await updateState(dir, (s) => {
    s.tasks[id] = {
      id,
      title: "x",
      status: "done",
      done_by: doneBy,
      done_at: "2026-01-01T00:00:00.000Z",
      note: "old note",
    };
    return s;
  });
}

test("reopen: orchestrator rolls done -> in_progress, sets claim, clears done_*", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupDone(dir, "T1", "agent-a");
    await reopen({
      statePath: dir,
      flags: { as: "orchestrator" },
      positional: ["T1", "le", "falta", "validacion"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "in_progress");
    assert.equal(s.tasks.T1.claimed_by, "orchestrator");
    assert.ok(s.tasks.T1.claimed_at);
    assert.equal(s.tasks.T1.done_by, undefined);
    assert.equal(s.tasks.T1.done_at, undefined);
    assert.equal(s.tasks.T1.note, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: original done_by can self-correct", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupDone(dir, "T1", "agent-a");
    await reopen({
      statePath: dir,
      flags: { as: "agent-a" },
      positional: ["T1", "missing", "edge", "case"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "in_progress");
    assert.equal(s.tasks.T1.claimed_by, "agent-a");
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: a third agent cannot reopen someone else's done task", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    await setupDone(dir, "T1", "agent-a");
    await assert.rejects(
      reopen({
        statePath: dir,
        flags: { as: "agent-b" },
        positional: ["T1", "I", "want", "to", "reopen"],
      }),
      /not authorized/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: fails if task is in_progress (already open)", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "agent-a" };
      return s;
    });
    await assert.rejects(
      reopen({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1", "r"] }),
      /not done/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: fails if task is ready (no status)", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(
      reopen({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1", "r"] }),
      /not done/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: fails if task is skipped (terminal by decision)", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "skipped" };
      return s;
    });
    await assert.rejects(
      reopen({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1", "r"] }),
      /not done/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: fails if task does not exist", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done" };
      return s;
    });
    await assert.rejects(
      reopen({ statePath: dir, flags: { as: "orchestrator" }, positional: ["NOPE", "r"] }),
      /not found/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: fails if no --as", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    await setupDone(dir, "T1", "agent-a");
    await assert.rejects(
      reopen({ statePath: dir, flags: {}, positional: ["T1", "r"] }),
      /--as/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: fails if reason is empty", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    await setupDone(dir, "T1", "agent-a");
    await assert.rejects(
      reopen({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1"] }),
      /reason/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: fails if state file missing", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      reopen({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1", "r"] }),
      /state file missing/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: log entry appended with the reason", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupDone(dir, "T1", "agent-a");
    await reopen({
      statePath: dir,
      flags: { as: "orchestrator" },
      positional: ["T1", "needs", "more", "tests"],
    });
    const s = await readState(dir);
    const entry = s.log.find((e) => e.action === "reopen" && e.task === "T1");
    assert.ok(entry, "log entry missing");
    assert.equal(entry.agent, "orchestrator");
    assert.match(entry.note, /needs more tests/);
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: downstream tasks re-block automatically (DAG consequence)", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const { readState } = await importFresh("./state.mjs");
  const { derive } = await importFresh("./dag.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    // T1 done, T2 depends on T1 — T2 is currently ready.
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done", done_by: "agent-a", done_at: "2026-01-01T00:00:00.000Z" };
      s.tasks.T2 = { id: "T2", depends_on: ["T1"] };
      return s;
    });
    let d = (await derive(await readState(dir)));
    assert.ok(d.ready.includes("T2"), "T2 should be ready while T1 is done");

    await reopen({
      statePath: dir,
      flags: { as: "orchestrator" },
      positional: ["T1", "broken", "foundation"],
    });
    d = derive(await readState(dir));
    assert.equal(d.ready.includes("T2"), false, "T2 should NOT be ready after T1 is reopened");
    assert.ok(d.blocked.includes("T2"), "T2 should be blocked after T1 is reopened");
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen: orchestrator can reopen own work (no done_by check needed)", async () => {
  const { default: reopen } = await importFresh("./commands/reopen.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupDone(dir, "T1", "agent-a");
    await reopen({
      statePath: dir,
      flags: { as: "orchestrator" },
      positional: ["T1", "auditing"],
    });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "in_progress");
  } finally {
    await rmTempProject(dir);
  }
});
