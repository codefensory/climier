// archive: mark a task as archived (terminal "we decided not to do this").
// Pattern is closest to done: requires a reason and clears claim metadata.
// Authority: in_progress requires the claimer (or orchestrator/recovery escape hatch);
// ready/blocked tasks can be archived by any agent with --as.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

async function setupTask(dir, id = "T1", patch = {}) {
  const { updateState } = await importFresh("./state.mjs");
  await updateState(dir, (s) => {
    s.tasks[id] = { id, title: "x", ...patch };
    return s;
  });
}

test("archive: marks archived, sets archived_at/archived_by/archive_reason, clears claim", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1", { status: "in_progress", claimed_by: "agent-a", claimed_at: Date.now() });
    await archive({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "obsolete"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "archived");
    assert.equal(s.tasks.T1.archived_by, "agent-a");
    assert.equal(s.tasks.T1.archive_reason, "obsolete");
    assert.equal(s.tasks.T1.claimed_by, undefined);
    assert.equal(s.tasks.T1.claimed_at, undefined);
    assert.ok(s.tasks.T1.archived_at);
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: works on a ready task (no claim) with any agent", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1");
    await archive({ statePath: dir, flags: { as: "agent-b" }, positional: ["T1", "skip"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "archived");
    assert.equal(s.tasks.T1.archived_by, "agent-b");
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: works on a blocked task with any agent", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1");
    await setupTask(dir, "T2");
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T2.depends_on = ["T1"];
      return s;
    });
    await archive({ statePath: dir, flags: { as: "agent-b" }, positional: ["T1", "obsolete"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "archived");
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: a reason is required (positional after id)", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1");
    await assert.rejects(
      archive({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1"] }),
      /reason/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: --as is required", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1");
    await assert.rejects(
      archive({ statePath: dir, flags: {}, positional: ["T1", "reason"] }),
      /--as/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: --as with no value is rejected (no bare flags)", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1");
    await assert.rejects(
      archive({ statePath: dir, flags: { as: true }, positional: ["T1", "reason"] }),
      /--as.*value/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: fails if task is not found", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1");
    await assert.rejects(
      archive({ statePath: dir, flags: { as: "a" }, positional: ["NOPE", "reason"] }),
      /not found/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: fails if state is missing", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      archive({ statePath: dir, flags: { as: "a" }, positional: ["T1", "reason"] }),
      /state file missing/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: fails on a task that is already archived (terminal)", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1", { status: "archived", archived_by: "agent-a", archive_reason: "old" });
    await assert.rejects(
      archive({ statePath: dir, flags: { as: "agent-b" }, positional: ["T1", "x"] }),
      /already archived/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: fails on a done task (done is terminal; use reopen first)", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1", { status: "done", done_by: "agent-a", note: "shipped" });
    await assert.rejects(
      archive({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "x"] }),
      /done/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: fails on in_progress if not the claimer and not orchestrator", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1", { status: "in_progress", claimed_by: "agent-a" });
    await assert.rejects(
      archive({ statePath: dir, flags: { as: "agent-b" }, positional: ["T1", "steal"] }),
      /not.*yours|not.*owner/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: orchestrator escape hatch works on someone else's in_progress", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1", { status: "in_progress", claimed_by: "agent-a" });
    await archive({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T1", "agent-a is gone"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "archived");
    assert.equal(s.tasks.T1.archived_by, "orchestrator");
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: recovery escape hatch works on someone else's in_progress", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1", { status: "in_progress", claimed_by: "agent-a" });
    await archive({ statePath: dir, flags: { as: "recovery" }, positional: ["T1", "abandoned"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.status, "archived");
    assert.equal(s.tasks.T1.archived_by, "recovery");
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: log entry appended with reason", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1");
    await archive({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "obsolete"] });
    const s = await readState(dir);
    const entry = s.log.find((e) => e.action === "archive" && e.task === "T1");
    assert.ok(entry);
    assert.equal(entry.note, "obsolete");
    assert.equal(entry.agent, "agent-a");
  } finally {
    await rmTempProject(dir);
  }
});

test("archive: clears block_reason (terminal cleanup, like done)", async () => {
  const { default: archive } = await importFresh("./commands/archive.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await setupTask(dir, "T1", { status: "in_progress", claimed_by: "agent-a", block_reason: "stale dep" });
    await archive({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1", "kill it"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.block_reason, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
