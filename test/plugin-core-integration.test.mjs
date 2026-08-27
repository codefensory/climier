// T-plugin-core-api — end-to-end integration of api.core.run.
//
// Exercises the first slice ADR-006 §"API y compatibilidad" against the
// real handlers in src/commands/*: task.create → edge.add → task.take →
// task.resolve → note.add. The flow runs over a fresh temp project with
// helpers.mjs (auto-managed CLIMIER_HOME under os.tmpdir()) so the real
// ~/.climier is never touched.
//
// What we verify:
//   - api.core.version === 2;
//   - api.core.run returns the real handler envelopes;
//   - flags.as is forced to api.runtime.agent (alice);
//   - plugin_id is recorded on every log entry produced through core.run;
//   - the state and the log are internally consistent;
//   - history <id> returns entries with the plugin_id attribution;
//   - error paths: PLUGIN_CORE_INVALID_OPERATION before mutation,
//     PLUGIN_CORE_ACTION_FAILED with structured cause when the handler
//     rejects, partial sequences when one operation in a chain fails.
//
// Concurrency and the full fixture live in T-plugin-core-e2e; here we
// only verify the dispatch + state-machine shape against the real
// handlers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
} from "./helpers.mjs";

// initV2Project — runs a v2 init + a single initiative so task.create
// can register against an existing initiative.
async function initV2Project(dir, initiatives = ["plugin-platform"]) {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  for (const name of initiatives) {
    await addInit({ statePath: dir, flags: { desc: name }, positional: [name] });
  }
}

async function makeApi(dir, { agent = "alice", pluginId = "example.core" } = {}) {
  const { createApi } = await importFresh("./plugin-api.mjs");
  return createApi({ projectDir: dir, agent, pluginId });
}

// ---------------------------------------------------------------------------
// Happy path — full first slice
// ---------------------------------------------------------------------------

test("plugin-core-integration: api.core.version is 2 and api.core.run is a function", async () => {
  const dir = await createTempProject();
  try {
    const api = await makeApi(dir);
    assert.equal(api.core.version, 2);
    assert.equal(typeof api.core.run, "function");
    // V1 surface still present.
    assert.equal(typeof api.runtime, "object");
    assert.equal(typeof api.query, "object");
    assert.equal(typeof api.data, "object");
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin-core-integration: full first slice leaves intact state and logs with plugin_id", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });

    // 1. task.create with an explicit id.
    const created = await api.core.run({
      op: "task.create",
      input: {
        id: "T-core-1",
        initiative: "plugin-platform",
        title: "Core task 1",
        body: "body",
        acceptance: "a",
        blocked_by: "",
      },
    });
    assert.ok(created && created.node && created.node.id);
    assert.equal(created.node.id, "T-core-1");
    assert.equal(created.node.kind, "resolvable");
    assert.equal(created.node.subkind, "task");

    // 2. edge.add between T-core-1 (blocker) and a freshly created T-core-2.
    //    Create T-core-2 standalone first (no blocked_by) so the explicit
    //    edge.add below does not duplicate an edge already in state.
    await api.core.run({
      op: "task.create",
      input: {
        id: "T-core-2",
        initiative: "plugin-platform",
        title: "Core task 2",
        body: "body",
        acceptance: "a",
        blocked_by: "",
      },
    });
    const edge = await api.core.run({
      op: "edge.add",
      input: { from: "T-core-1", to: "T-core-2", type: "BLOCKS" },
    });
    assert.ok(edge && edge.edge && edge.edge.type === "BLOCKS");
    assert.equal(edge.edge.from, "T-core-1");
    assert.equal(edge.edge.to, "T-core-2");

    // 3. task.take on T-core-1 (owner = alice = api.runtime.agent).
    const taken = await api.core.run({
      op: "task.take",
      input: { id: "T-core-1" },
    });
    assert.ok(taken && taken.node && taken.context);
    assert.equal(taken.node.claim && taken.node.claim.by, "alice");
    assert.equal(taken.freshly_claimed, true);

    // 4. task.resolve with a note (owner matches).
    const resolved = await api.core.run({
      op: "task.resolve",
      input: { id: "T-core-1", note: "shipped via core.run" },
    });
    assert.ok(resolved && resolved.node);
    assert.equal(resolved.node.status, "done");
    assert.equal(resolved.node.done_by, "alice");
    assert.equal(resolved.node.note, "shipped via core.run");

    // 5. note.add on T-core-2.
    const noted = await api.core.run({
      op: "note.add",
      input: { id: "T-core-2", text: "context note via core.run" },
    });
    assert.ok(noted && noted.node);
    assert.ok(
      Array.isArray(noted.node.notes) &&
        noted.node.notes.some((n) => n.text === "context note via core.run"),
    );

    // ---- State assertions --------------------------------------------
    const s = await readState(dir);
    // Both task nodes exist with correct status.
    assert.equal(s.nodes["T-core-1"].status, "done");
    assert.equal(s.nodes["T-core-2"].status, "open");
    // The BLOCKS edge is present.
    const blocks = s.edges.find(
      (e) => e.from === "T-core-1" && e.to === "T-core-2" && e.type === "BLOCKS",
    );
    assert.ok(blocks, "BLOCKS edge between the two tasks exists");
    // Log entries: every plugin-initiated handler call has plugin_id and
    // an agent of alice (api.runtime.agent).
    const pluginLogs = s.log.filter((e) => e.plugin_id === "example.core");
    assert.ok(pluginLogs.length >= 5, `expected at least 5 plugin-tagged logs, got ${pluginLogs.length}`);
    for (const entry of pluginLogs) {
      assert.equal(entry.agent, "alice", `log agent must be alice: ${JSON.stringify(entry)}`);
    }
    // Five distinct actions tagged: add-node, add-node, add-edge, take, resolve, add-note.
    const seenActions = new Set(pluginLogs.map((e) => e.action));
    for (const a of ["add-node", "add-edge", "take", "resolve", "add-node"]) {
      assert.ok(seenActions.has(a), `expected an action '${a}' in plugin logs`);
    }
    // No log carries agent other than alice for plugin-initiated writes.
    const nonAlice = pluginLogs.filter((e) => e.agent !== "alice");
    assert.equal(nonAlice.length, 0, `plugin logs must record api.runtime.agent; offenders: ${JSON.stringify(nonAlice)}`);
  } finally {
    await rmTempProject(dir);
  }
});

// ---------------------------------------------------------------------------
// history <id> reflects plugin_id attribution surfaced by api.core.run
// ---------------------------------------------------------------------------

test("plugin-core-integration: history for a node touched via core.run reports plugin_id on the entries", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    await api.core.run({
      op: "task.create",
      input: {
        id: "T-hist",
        initiative: "plugin-platform",
        title: "history task",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    await api.core.run({ op: "task.take", input: { id: "T-hist" } });
    await api.core.run({
      op: "note.add",
      input: { id: "T-hist", text: "ctx" },
    });
    const out = await api.query.history("T-hist");
    assert.equal(out.id, "T-hist");
    assert.ok(out.entries.length >= 3, "history must list at least 3 entries");
    for (const entry of out.entries) {
      assert.equal(entry.plugin_id, "example.core", `history entry missing plugin_id: ${JSON.stringify(entry)}`);
    }
  } finally {
    await rmTempProject(dir);
  }
});

// ---------------------------------------------------------------------------
// Error envelope coverage — no mutation on PLUGIN_CORE_INVALID_OPERATION
// ---------------------------------------------------------------------------

test("plugin-core-integration: PLUGIN_CORE_INVALID_OPERATION does not mutate and lists supported ops", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    const before = await readState(dir);
    const beforeEdges = before.edges.length;
    const beforeNodes = Object.keys(before.nodes).length;
    const beforeLogs = before.log.length;
    // Unknown op — must reject before any lock.
    await assert.rejects(
      api.core.run({ op: "task.delete", input: { id: "T-hist" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.op === "task.delete" &&
        err.details.reason === "unknown operation" &&
        err.details.plugin_id === "example.core",
      "unknown op must be rejected as PLUGIN_CORE_INVALID_OPERATION",
    );
    // input.as — must reject.
    await assert.rejects(
      api.core.run({
        op: "task.create",
        input: {
          initiative: "plugin-platform",
          title: "as-spoof",
          body: "b",
          acceptance: "a",
          blocked_by: "",
          as: "bob",
        },
      }),
      (err) =>
        err && err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
        err.details.reason === "input.as is forbidden",
    );
    // Empty input.
    await assert.rejects(
      api.core.run({ op: "task.create", input: {} }),
      (err) => err && err.code === "PLUGIN_CORE_INVALID_OPERATION",
    );
    const after = await readState(dir);
    assert.equal(after.edges.length, beforeEdges, "no edges added by rejected runs");
    assert.equal(
      Object.keys(after.nodes).length,
      beforeNodes,
      "no nodes added by rejected runs",
    );
    assert.equal(
      after.log.length,
      beforeLogs,
      "no log entries added by rejected runs",
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("plugin-core-integration: handler-rejected actions surface as PLUGIN_CORE_ACTION_FAILED with structured cause", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    // task.take against a non-existent task throws NODE_NOT_FOUND.
    await assert.rejects(
      api.core.run({ op: "task.take", input: { id: "T-bogus" } }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "task.take" &&
        err.details.plugin_id === "example.core" &&
        err.details.cause &&
        err.details.cause.code === "NODE_NOT_FOUND",
    );
    // add-edge from a missing node → INVALID_EDGE_TARGET (add-edge
    // validates both endpoints before mutating). The adapter wraps it
    // as PLUGIN_CORE_ACTION_FAILED with the structured cause.
    await assert.rejects(
      api.core.run({
        op: "edge.add",
        input: { from: "T-no", to: "T-still-no", type: "BLOCKS" },
      }),
      (err) =>
        err &&
        err.code === "PLUGIN_CORE_ACTION_FAILED" &&
        err.details.op === "edge.add" &&
        err.details.cause &&
        (err.details.cause.code === "INVALID_EDGE_TARGET" ||
          err.details.cause.code === "NODE_NOT_FOUND" ||
          err.details.cause.code === "CORE_ERROR"),
    );
  } finally {
    await rmTempProject(dir);
  }
});

// ---------------------------------------------------------------------------
// Partial sequences — the host does not roll back; the plugin sees its own
// success / failure via try/catch (ADR-006 §"Secuencias parciales").
// ---------------------------------------------------------------------------

test("plugin-core-integration: a successful task.create is preserved when a subsequent edge.add fails", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const api = await makeApi(dir, { agent: "alice", pluginId: "example.core" });
    // Success: create the task.
    await api.core.run({
      op: "task.create",
      input: {
        id: "T-partial-1",
        initiative: "plugin-platform",
        title: "t",
        body: "b",
        acceptance: "a",
        blocked_by: "",
      },
    });
    // Failure: edge.add to a missing target.
    await assert.rejects(
      api.core.run({
        op: "edge.add",
        input: { from: "T-partial-1", to: "T-partial-2-missing", type: "BLOCKS" },
      }),
      (err) => err && err.code === "PLUGIN_CORE_ACTION_FAILED",
    );
    // The previously created task is still present (no roll-back).
    const after = await readState(dir);
    assert.ok(after.nodes["T-partial-1"], "T-partial-1 survives a failed follow-up");
    assert.equal(after.nodes["T-partial-1"].status, "open");
    assert.equal(
      after.edges.length,
      0,
      "no BLOCKS edge added because edge.add failed before the lock",
    );
  } finally {
    await rmTempProject(dir);
  }
});

// ---------------------------------------------------------------------------
// Concurrency shape — two plugins calling core.run in parallel land both
// writes intact. Concurrency across processes belongs to T-plugin-core-e2e.
// ---------------------------------------------------------------------------

test("plugin-core-integration: two plugins calling core.run in parallel land both writes intact", async () => {
  const dir = await createTempProject();
  try {
    await initV2Project(dir);
    const apiA = await makeApi(dir, { agent: "alice", pluginId: "example.plugin-a" });
    const apiB = await makeApi(dir, { agent: "bob", pluginId: "example.plugin-b" });
    const [outA, outB] = await Promise.all([
      apiA.core.run({
        op: "task.create",
        input: {
          id: "T-A",
          initiative: "plugin-platform",
          title: "A",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      }),
      apiB.core.run({
        op: "task.create",
        input: {
          id: "T-B",
          initiative: "plugin-platform",
          title: "B",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      }),
    ]);
    assert.equal(outA.node.id, "T-A");
    assert.equal(outB.node.id, "T-B");
    const after = await readState(dir);
    assert.ok(after.nodes["T-A"]);
    assert.ok(after.nodes["T-B"]);
    const aLogs = after.log.filter((e) => e.plugin_id === "example.plugin-a");
    const bLogs = after.log.filter((e) => e.plugin_id === "example.plugin-b");
    assert.ok(aLogs.length >= 1, "plugin A produced at least one log entry");
    assert.ok(bLogs.length >= 1, "plugin B produced at least one log entry");
    // Agents reflect each plugin's api.runtime.agent, not the plugin id.
    for (const e of aLogs) assert.equal(e.agent, "alice");
    for (const e of bLogs) assert.equal(e.agent, "bob");
  } finally {
    await rmTempProject(dir);
  }
});
