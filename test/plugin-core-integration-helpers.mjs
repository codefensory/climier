import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
} from "./helpers.ts";

// Shared setup for the core API integration cases.
export async function initProject(dir, initiatives = ["plugin-platform"]) {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
  for (const name of initiatives) {
    await addInit({ statePath: dir, flags: { desc: name }, positional: [name] });
  }
}

export async function makeApi(dir, { agent = "alice", pluginId = "example.core" } = {}) {
  const { createApi } = await importFresh("./plugins/api.ts");
  return createApi({ projectDir: dir, agent, pluginId });
}

function assertEnvelope(result) {
  assert.ok(result && result.result && result.diff && result.log_entry);
}

function assertCoreLog(result, action) {
  assert.equal(result.log_entry.action, action);
  assert.equal(result.log_entry.agent, "alice");
  assert.equal(result.log_entry.plugin_id, "example.core");
}

export async function createFirstTask(api, dir) {
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
  assertEnvelope(created);
  assert.equal(created.result.id, "T-core-1");
  assert.equal(created.result.kind, "resolvable");
  assert.equal(created.result.subkind, "task");
  assert.equal(created.diff.created[0].node.id, "T-core-1");
  assert.equal(created.diff.created[0].node.revision, (await readState(dir)).revision);
  assertCoreLog(created, "task.create");
}

export async function createSecondTask(api) {
  return api.core.run({
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
}

export async function addBlockingEdge(api) {
  const edge = await api.core.run({
    op: "edge.add",
    input: { from: "T-core-1", to: "T-core-2", type: "BLOCKS" },
  });
  assertEnvelope(edge);
  assert.equal(edge.result.edge.type, "BLOCKS");
  assert.equal(edge.result.edge.from, "T-core-1");
  assert.equal(edge.result.edge.to, "T-core-2");
  assert.deepEqual(edge.diff.added_edges, [edge.result.edge]);
  assertCoreLog(edge, "edge.add");
}

export async function takeFirstTask(api, dir) {
  const taken = await api.core.run({ op: "task.take", input: { id: "T-core-1" } });
  assertEnvelope(taken);
  assert.equal(taken.result.claim && taken.result.claim.by, "alice");
  assert.equal(taken.result.freshly_claimed, true);
  assert.equal(taken.diff.updated[0].node.revision, (await readState(dir)).revision);
  assertCoreLog(taken, "task.take");
}

export async function submitFirstTask(api, dir) {
  const submitted = await api.core.run({
    op: "task.submit",
    input: { id: "T-core-1", note: "shipped via core.run" },
  });
  assertEnvelope(submitted);
  assert.equal(submitted.result.status, "submitted");
  assert.equal(submitted.result.note, "shipped via core.run");
  assert.equal(submitted.diff.updated[0].node.revision, (await readState(dir)).revision);
  assertCoreLog(submitted, "task.submit");
}

export async function acceptFirstTask(api, dir) {
  const accepted = await api.core.run({ op: "task.accept", input: { id: "T-core-1" } });
  assertEnvelope(accepted);
  assert.equal(accepted.result.status, "done");
  assert.equal(accepted.result.done_by, "alice");
  assert.deepEqual(accepted.effects, { newly_ready: ["T-core-2"] });
  assert.equal(accepted.diff.updated[0].node.revision, (await readState(dir)).revision);
  assertCoreLog(accepted, "task.accept");
}

export async function addNoteToSecondTask(api, dir, created2) {
  const noted = await api.core.run({
    op: "note.add",
    input: {
      id: "T-core-2",
      text: "context note via core.run",
      if_revision: created2.diff.created[0].node.revision,
    },
  });
  assertEnvelope(noted);
  assert.equal(noted.result.notes_count, 1);
  assert.equal(noted.diff.updated[0].node.revision, (await readState(dir)).revision);
  assertCoreLog(noted, "note.add");
  const notedNode = (await readState(dir)).nodes["T-core-2"];
  assert.ok(notedNode.notes.some((n) => n.text === "context note via core.run"));
}

export async function assertFullSliceState(dir) {
  const s = await readState(dir);
  assert.equal(s.nodes["T-core-1"].status, "done");
  assert.equal(s.nodes["T-core-2"].status, "open");
  const blocks = s.edges.find(
    (e) => e.from === "T-core-1" && e.to === "T-core-2" && e.type === "BLOCKS",
  );
  assert.ok(blocks, "BLOCKS edge between the two tasks exists");
  const pluginLogs = s.log.filter((e) => e.plugin_id === "example.core");
  assert.ok(pluginLogs.length >= 5, `expected at least 5 plugin-tagged logs, got ${pluginLogs.length}`);
  for (const entry of pluginLogs) {
    assert.equal(entry.agent, "alice", `log agent must be alice: ${JSON.stringify(entry)}`);
  }
  const seenActions = new Set(pluginLogs.map((e) => e.action));
  for (const a of ["task.create", "edge.add", "task.take", "task.submit", "task.accept", "note.add"]) {
    assert.ok(seenActions.has(a), `expected an action '${a}' in plugin logs`);
  }
  const nonAlice = pluginLogs.filter((e) => e.agent !== "alice");
  assert.equal(nonAlice.length, 0, `plugin logs must record api.runtime.agent; offenders: ${JSON.stringify(nonAlice)}`);
}

export async function rejectUnknownCoreOperation(api) {
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
}

export async function rejectSpoofedActor(api) {
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
      err &&
      err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
      err.details.reason === "input.as is forbidden",
  );
}

export async function rejectNonObjectCoreInput(api) {
  await assert.rejects(
    api.core.run({ op: "task.create", input: null }),
    (err) =>
      err &&
      err.code === "PLUGIN_CORE_INVALID_OPERATION" &&
      err.details.reason === "input must be an object",
  );
}

export function assertParallelCreates(outA, outB, revisionBefore) {
  assert.equal(outA.result.id, "T-A");
  assert.equal(outB.result.id, "T-B");
  assert.deepEqual(
    [outA.diff.created[0].node.revision, outB.diff.created[0].node.revision].toSorted((a, b) => a - b),
    [revisionBefore + 1, revisionBefore + 2],
    "parallel creates receive distinct, increasing global revisions",
  );
  assert.equal(outA.log_entry.action, "task.create");
  assert.equal(outB.log_entry.action, "task.create");
}

export function assertParallelLogs(after) {
  assert.ok(after.nodes["T-A"]);
  assert.ok(after.nodes["T-B"]);
  const aLogs = after.log.filter((e) => e.plugin_id === "example.plugin-a");
  const bLogs = after.log.filter((e) => e.plugin_id === "example.plugin-b");
  assert.ok(aLogs.length >= 1, "plugin A produced at least one log entry");
  assert.ok(bLogs.length >= 1, "plugin B produced at least one log entry");
  // Agents reflect each plugin's api.runtime.agent, not the plugin id.
  for (const e of aLogs) {
    assert.equal(e.agent, "alice");
  }
  for (const e of bLogs) {
    assert.equal(e.agent, "bob");
  }
}

export function taskInput(id, title) {
  return {
    id,
    initiative: "plugin-platform",
    title,
    body: "b",
    acceptance: "a",
    blocked_by: "",
  };
}

export { createTempProject, rmTempProject, readState };
