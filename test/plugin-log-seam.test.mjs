// T-plugin-core-log-seam — appendWithContext seam and plugin_id attribution.
//
// ADR-006 §"Locks y logs" and the bootstrap plan §3.3 require that V2
// plugin core actions write `plugin_id` in the global state log so
// `history <id>` can attribute the action to its plugin. The CLI path
// must stay unchanged: no plugin_id when no plugin is the caller.
//
// Coverage:
//   1. appendWithContext adds plugin_id only for a valid pluginId and
//      leaves the entry shape compatible with append().
//   2. The five handlers of the first slice — add-task, add-edge, take,
//      resolve, add-note — write plugin_id when ctx.pluginId is present
//      and never write it on the normal CLI path.
//   3. The invariant withLock → updateState → append holds: a single log
//      entry per handler call, no parallel logs.
//
// Isolation: per-test temp CLIMIER_HOME under os.tmpdir() (helpers.mjs)
// and per-test temp project dir; commands are imported fresh so the
// module cache does not leak across tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
} from "./helpers.mjs";

// ---------------------------------------------------------------------------
// appendWithContext unit tests
// ---------------------------------------------------------------------------

test("appendWithContext: adds plugin_id when ctx.pluginId is a non-empty string", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await appendWithContext(
      dir,
      { agent: "alice", action: "add-task", node: "T1" },
      { pluginId: "example.audit" },
    );
    const s = await readState(dir);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].action, "add-task");
    assert.equal(s.log[0].agent, "alice");
    assert.equal(s.log[0].plugin_id, "example.audit");
    assert.equal(s.log[0].node, "T1");
    assert.ok(s.log[0].ts);
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: omits plugin_id when ctx is undefined", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await appendWithContext(dir, { agent: "alice", action: "add-task", node: "T1" });
    const s = await readState(dir);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: omits plugin_id when ctx.pluginId is missing", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await appendWithContext(dir, { agent: "alice", action: "add-task", node: "T1" }, {});
    const s = await readState(dir);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: omits plugin_id when ctx.pluginId is not a string", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await appendWithContext(
      dir,
      { agent: "alice", action: "add-task", node: "T1" },
      { pluginId: 42 },
    );
    const s = await readState(dir);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: omits plugin_id when ctx.pluginId is empty / whitespace", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dirA = await createTempProject();
  const dirB = await createTempProject();
  try {
    await appendWithContext(
      dirA,
      { agent: "alice", action: "add-task", node: "T1" },
      { pluginId: "" },
    );
    await appendWithContext(
      dirB,
      { agent: "alice", action: "add-task", node: "T1" },
      { pluginId: "   " },
    );
    const a = await readState(dirA);
    const b = await readState(dirB);
    assert.equal(a.log[0].plugin_id, undefined);
    assert.equal(b.log[0].plugin_id, undefined);
  } finally {
    await rmTempProject(dirA);
    await rmTempProject(dirB);
  }
});

test("appendWithContext: trims surrounding whitespace from pluginId", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await appendWithContext(
      dir,
      { agent: "alice", action: "add-task", node: "T1" },
      { pluginId: "  example.audit  " },
    );
    const s = await readState(dir);
    assert.equal(s.log[0].plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: rejects when entry is not an object (validation propagates)", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      appendWithContext(dir, null, { pluginId: "example.audit" }),
      /append: (entry must be an object|entry\.action is required)/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: rejects when entry.action is missing (validation propagates)", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      appendWithContext(dir, { agent: "alice" }, { pluginId: "example.audit" }),
      /append: entry\.action is required/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: rejects when entry.agent is missing (validation propagates)", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      appendWithContext(dir, { action: "x" }, { pluginId: "example.audit" }),
      /append: entry\.agent is required/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("appendWithContext: never mutates the entry passed in by the caller", async () => {
  const { appendWithContext } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    const entry = { agent: "alice", action: "add-task", node: "T1" };
    await appendWithContext(dir, entry, { pluginId: "example.audit" });
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// ---------------------------------------------------------------------------
// Per-handler integration tests
// ---------------------------------------------------------------------------

async function initV2Project(dir, initiatives = ["plugin-platform"]) {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  for (const name of initiatives) {
    await addInit({ statePath: dir, flags: { desc: name }, positional: [name] });
  }
}

async function seedOpenTask(dir, id, { initiative = "plugin-platform", status = "open" } = {}) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  await addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: id,
      initiative,
      status,
    },
  });
}

function lastLog(state) {
  return state.log[state.log.length - 1];
}

// ----- add-task -------------------------------------------------------------

test("add-task: CLI call writes add-node log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");
    await addTask({
      statePath: dir,
      flags: {
        as: "alice",
        initiative: "plugin-platform",
        title: "T1",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
      },
      positional: ["T1"],
      projectDir: dir,
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-node");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T1");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: ctx.pluginId is propagated to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");
    await addTask({
      statePath: dir,
      flags: {
        as: "alice",
        initiative: "plugin-platform",
        title: "T1",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
      },
      positional: ["T1"],
      projectDir: dir,
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-node");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
    // Verify the previous CLI add-task log entries (none in this test)
    // did not duplicate: the last entry is from this call only.
  } finally {
    await rmTempProject(dir);
  }
});

test("add-task: two consecutive calls (one CLI, one plugin) produce two distinct log entries with correct attribution", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const { default: addTask } = await importFresh("./commands/add-task.mjs");
    await addTask({
      statePath: dir,
      flags: {
        as: "alice",
        initiative: "plugin-platform",
        title: "T-cli",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
      },
      positional: ["T-cli"],
      projectDir: dir,
    });
    await addTask({
      statePath: dir,
      flags: {
        as: "alice",
        initiative: "plugin-platform",
        title: "T-plugin",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
      },
      positional: ["T-plugin"],
      projectDir: dir,
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    // initV2Project calls add-initiative once (which now writes a log
    // entry per ADR-006 §"Locks y logs" / plan §4.3 to close the
    // parity-slice gap), plus the two add-task calls — three entries
    // total. The first entry is the initiative bootstrap, the next
    // two are the add-task CLI + plugin calls.
    assert.equal(s.log.length, 3);
    assert.equal(s.log[0].action, "add-initiative");
    assert.equal(s.log[0].node, "plugin-platform");
    assert.equal(s.log[0].plugin_id, undefined);
    assert.equal(s.log[1].node, "T-cli");
    assert.equal(s.log[1].plugin_id, undefined);
    assert.equal(s.log[2].node, "T-plugin");
    assert.equal(s.log[2].plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});

// ----- add-edge -------------------------------------------------------------

test("add-edge: CLI call writes add-edge log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-a");
    await seedOpenTask(dir, "T-b");
    const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
    await addEdge({ statePath: dir, flags: { as: "alice", type: "BLOCKS" }, positional: ["T-a", "T-b"] });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-edge");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-b");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-edge: ctx.pluginId propagates to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-a");
    await seedOpenTask(dir, "T-b");
    const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
    await addEdge({
      statePath: dir,
      flags: { as: "alice", type: "BLOCKS" },
      positional: ["T-a", "T-b"],
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-edge");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});

// ----- take -----------------------------------------------------------------

test("take: CLI call writes take log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-take-1");
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({ statePath: dir, flags: { as: "alice" }, positional: ["T-take-1"], projectDir: dir });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "take");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-take-1");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("take: ctx.pluginId propagates to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-take-2");
    const { default: take } = await importFresh("./commands/take.mjs");
    await take({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-take-2"],
      projectDir: dir,
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "take");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});

// ----- resolve --------------------------------------------------------------

test("resolve (task): CLI call writes resolve log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-resolve-1", { status: "in_progress" });
    const { updateState } = await importFresh("./storage/state.mjs");
    await updateState(dir, (st) => {
      st.nodes["T-resolve-1"].claim = { by: "alice", at: new Date().toISOString() };
      return st;
    });
    const { default: resolve } = await importFresh("./commands/resolve.mjs");
    await resolve({
      statePath: dir,
      flags: { as: "alice", note: "done" },
      positional: ["T-resolve-1"],
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "resolve");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-resolve-1");
    assert.equal(entry.note, "done");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("resolve (task): ctx.pluginId propagates to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-resolve-2", { status: "in_progress" });
    const { updateState } = await importFresh("./storage/state.mjs");
    await updateState(dir, (st) => {
      st.nodes["T-resolve-2"].claim = { by: "alice", at: new Date().toISOString() };
      return st;
    });
    const { default: resolve } = await importFresh("./commands/resolve.mjs");
    await resolve({
      statePath: dir,
      flags: { as: "alice", note: "done" },
      positional: ["T-resolve-2"],
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "resolve");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
    assert.equal(entry.note, "done");
  } finally {
    await rmTempProject(dir);
  }
});

// ----- add-note -------------------------------------------------------------

test("add-note: CLI call writes add-note log entry without plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-note-1");
    const { default: addNote } = await importFresh("./commands/add-note.mjs");
    await addNote({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-note-1", "context note"],
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-note");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.node, "T-note-1");
    assert.equal(entry.note, "context note");
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-note: ctx.pluginId propagates to the log entry as plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-note-2");
    const { default: addNote } = await importFresh("./commands/add-note.mjs");
    await addNote({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-note-2", "context note"],
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    const entry = lastLog(s);
    assert.equal(entry.action, "add-note");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.plugin_id, "example.audit");
  } finally {
    await rmTempProject(dir);
  }
});

// ----- Invariant: withLock → updateState → append --------------------------------

test("plugin-log-seam: handlers still observe withLock → updateState → append order (one log per handler call)", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    await seedOpenTask(dir, "T-flow");
    await seedOpenTask(dir, "T-flow-2");
    const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
    const { default: take } = await importFresh("./commands/take.mjs");
    const { default: addNote } = await importFresh("./commands/add-note.mjs");
    await addEdge({
      statePath: dir,
      flags: { as: "alice", type: "BLOCKS" },
      positional: ["T-flow", "T-flow-2"],
      pluginId: "example.audit",
    });
    await take({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-flow"],
      projectDir: dir,
      pluginId: "example.audit",
    });
    await addNote({
      statePath: dir,
      flags: { as: "alice" },
      positional: ["T-flow", "ctx"],
      pluginId: "example.audit",
    });
    const s = await readState(dir);
    // Three plugin-initiated handler calls. Each must produce exactly
    // one log entry that carries plugin_id. (The CLI seeding calls
    // produced entries with no plugin_id earlier; we only inspect the
    // last three entries, which correspond to the three plugin calls.)
    const tail = s.log.slice(-3);
    assert.equal(tail.length, 3);
    assert.equal(tail[0].action, "add-edge");
    assert.equal(tail[1].action, "take");
    assert.equal(tail[2].action, "add-note");
    for (const entry of tail) {
      assert.equal(entry.plugin_id, "example.audit");
      assert.equal(entry.agent, "alice");
    }
    // Each entry has a unique ts and unique action so no interleaving.
    const actions = tail.map((e) => e.action);
    assert.equal(new Set(actions).size, actions.length);
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin-log-seam: append() CLI path still works after the seam is added", async () => {
  const { append } = await importFresh("./log.mjs");
  const dir = await createTempProject();
  try {
    await append(dir, { agent: "alice", action: "add-task", node: "T1" });
    const s = await readState(dir);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].action, "add-task");
    assert.equal(s.log[0].plugin_id, undefined);
    assert.equal(s.log[0].agent, "alice");
  } finally {
    await rmTempProject(dir);
  }
});
