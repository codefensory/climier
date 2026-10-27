import test from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, runCli, writeCanonicalState } from "./helpers.ts";

function fixture() {
  return {
    version: 1,
    revision: 1,
    initiatives: {},
    nodes: {
      "T-a": { id: "T-a", kind: "resolvable", subkind: "task", title: "A", status: "open", revision: 1 },
      "T-b": { id: "T-b", kind: "resolvable", subkind: "task", title: "B", status: "open", revision: 1 },
    },
    edges: [],
    log: [
      { action: "create", agent: "alice", node: "T-a", ts: "2026-10-20T00:00:00.000Z" },
      { action: "create", agent: "bob", node: "T-b", ts: "2026-10-20T00:01:00.000Z" },
      { action: "update", agent: "alice", node: "T-a", ts: "2026-10-20T00:02:00.000Z" },
      { action: "note.add", agent: "dana", note: "mention T-a in this note", ts: "2026-10-20T00:02:30.000Z" },
      { action: "take", agent: "carol", node: "T-b", ts: "2026-10-20T00:03:00.000Z" },
      { action: "submit", agent: "alice", node: "T-a", ts: "2026-10-20T00:04:00.000Z" },
    ],
  };
}

async function cli(dir, ...args: string[]) {
  return runCli(["--project", dir, ...args]);
}

async function historyFor(dir, id) {
  const result = await cli(dir, "history", id);
  assert.equal(result.code, 0, result.stdout);
  return JSON.parse(result.stdout).entries;
}

async function assertRestoreRoundTrip(dir, snapshotId, exported) {
  const changed = await cli(dir, "state", "compact", "--keep", "0", "--as", "worker");
  assert.equal(changed.code, 0, changed.stdout);
  const restored = await cli(dir, "restore", snapshotId, "--as", "worker");
  assert.equal(restored.code, 0, restored.stdout);
  const after = await (await import("../src/storage/state.ts")).readState(dir);
  assert.equal(after.nodes["T-a"].title, "A");
  assert.deepEqual(after.log.slice(0, exported.log.length), exported.log);
  assert.equal(after.log.at(-1).action, "restore");
  const entries = await historyFor(dir, "T-a");
  assert.equal(entries[0].checkpoint.count, 4);
  assert.equal(entries[0].action, "checkpoint.summary");
}

test("state compact keeps the newest N log entries and per-node summaries visible in history", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, fixture());
    const result = await cli(dir, "state", "compact", "--keep", "2", "--as", "worker");
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      retained: 2,
      summarized: 4,
      nodes: 2,
    });

    const stateResult = await cli(dir, "state", "export");
    assert.equal(stateResult.code, 0, stateResult.stdout);
    const state = JSON.parse(stateResult.stdout);
    assert.equal(state.nodes["T-a"].revision, 1, "compaction does not revise unchanged nodes");
    assert.equal(state.nodes["T-b"].revision, 1, "compaction does not revise unchanged nodes");
    assert.equal(state.log.filter((entry) => entry.action === "checkpoint.summary").length, 2);
    assert.deepEqual(state.log.at(-1), {
      action: "state.compact",
      agent: "worker",
      keep: 2,
      summarized: 4,
      summarized_nodes: 2,
      ts: state.log.at(-1).ts,
    });

    const historyA = await historyFor(dir, "T-a");
    assert.deepEqual(historyA.map((entry) => entry.action), ["checkpoint.summary", "submit"]);
    assert.deepEqual(historyA[0].checkpoint, {
      count: 3,
      first_ts: "2026-10-20T00:00:00.000Z",
      last_ts: "2026-10-20T00:02:30.000Z",
      actions: { create: 1, "note.add": 1, update: 1 },
      agents: { alice: 2, dana: 1 },
    });

    const historyB = await historyFor(dir, "T-b");
    assert.deepEqual(historyB.map((entry) => entry.action), ["checkpoint.summary", "take"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("repeated compaction merges checkpoints and state export survives restore", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, fixture());
    const first = await cli(dir, "state", "compact", "--keep", "2", "--as", "worker");
    assert.equal(first.code, 0, first.stdout);
    const second = await cli(dir, "state", "compact", "--keep", "1", "--as", "worker");
    assert.equal(second.code, 0, second.stdout);
    assert.deepEqual(JSON.parse(second.stdout), { retained: 1, summarized: 2, nodes: 2 });

    const { createSnapshot } = await import("../src/storage/state.ts");
    const checkpoint = await createSnapshot(dir, "force-init");
    const exported = JSON.parse((await cli(dir, "state", "export")).stdout);
    const summaries = exported.log.filter((entry) => entry.action === "checkpoint.summary");
    assert.deepEqual(summaries.map((entry) => [entry.node, entry.checkpoint.count]), [["T-a", 4], ["T-b", 2]]);

    await assertRestoreRoundTrip(dir, checkpoint.id, exported);
  } finally {
    await rmTempProject(dir);
  }
});

test("state compact defaults to retaining the latest 1000 log entries", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, fixture());
    const result = await cli(dir, "state", "compact", "--as", "worker");
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { retained: 6, summarized: 0, nodes: 0 });
    const exported = JSON.parse((await cli(dir, "state", "export")).stdout);
    assert.equal(exported.log.at(-1).keep, 1000);
  } finally {
    await rmTempProject(dir);
  }
});

test("state compact rejects invalid retention and requires an actor", async () => {
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, fixture());
    const missingActor = await runCli(["--project", dir, "state", "compact", "--keep", "1"], { env: { CLIMIER_AGENT: undefined } });
    assert.notEqual(missingActor.code, 0);
    assert.match(missingActor.stdout, /agent/i);
    const invalidKeep = await cli(dir, "state", "compact", "--keep", "-1", "--as", "worker");
    assert.notEqual(invalidKeep.code, 0);
    assert.match(invalidKeep.stdout, /non-negative integer/);
  } finally {
    await rmTempProject(dir);
  }
});
