// TDD for ADR-022 piece 6: touch refreshes claim.heartbeat_at (D1: real mutation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

async function v2Project() {
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.mjs");
  const dir = await createTempProject();
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
  return dir;
}

async function addTask(dir, id) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: { kind: "resolvable", subkind: "task", title: id, initiative: "auth" },
  });
}

async function cmd(path, dir, positional, flags) {
  const { default: fn } = await importFresh(path);
  return fn({ statePath: dir, projectDir: dir, positional, flags });
}

test("touch advances claim.heartbeat_at without changing status or owner", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-t-1");
    const taken = await cmd("./cli/commands/take.mjs", dir, ["T-t-1"], { as: "alice", meta: '{"pid":3}' });
    const before = taken.node.claim.at;
    const stateBefore = await readState(dir);
    const revisionBefore = stateBefore.nodes["T-t-1"].revision;
    const logLengthBefore = stateBefore.log.length;

    const out = await cmd("./cli/commands/touch.mjs", dir, ["T-t-1"], { as: "alice" });
    assert.equal(out.node.status, "in_progress");
    assert.equal(out.node.claim.by, "alice");
    assert.equal(out.node.claim.at, before);
    assert.deepEqual(out.node.claim.meta, { pid: 3 });
    assert.equal(typeof out.node.claim.heartbeat_at, "string");
    assert.ok(out.node.claim.heartbeat_at >= before);

    const stateAfter = await readState(dir);
    assert.equal(stateAfter.nodes["T-t-1"].revision, revisionBefore + 1);
    assert.equal(stateAfter.log.length, logLengthBefore + 1);
    assert.equal(stateAfter.log.at(-1).action, "touch");
  } finally { await rmTempProject(dir); }
});

test("touch at the same timestamp is a successful revisioned mutation", async () => {
  const dir = await v2Project();
  const NativeDate = globalThis.Date;
  try {
    await addTask(dir, "T-t-same-ms");
    await cmd("./cli/commands/take.mjs", dir, ["T-t-same-ms"], { as: "alice" });
    const fixedAt = "2026-01-02T03:04:05.000Z";
    globalThis.Date = class extends NativeDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedAt] : args));
      }
      static now() { return NativeDate.parse(fixedAt); }
    };
    const first = await cmd("./cli/commands/touch.mjs", dir, ["T-t-same-ms"], { as: "alice" });
    const beforeSecond = await readState(dir);
    const second = await cmd("./cli/commands/touch.mjs", dir, ["T-t-same-ms"], { as: "alice" });
    const afterSecond = await readState(dir);

    assert.equal(Date.parse(second.node.claim.heartbeat_at), Date.parse(first.node.claim.heartbeat_at) + 1);
    assert.equal(afterSecond.nodes["T-t-same-ms"].revision, beforeSecond.nodes["T-t-same-ms"].revision + 1);
    assert.equal(afterSecond.log.length, beforeSecond.log.length + 1);
    assert.equal(afterSecond.log.at(-1).action, "touch");
  } finally {
    globalThis.Date = NativeDate;
    await rmTempProject(dir);
  }
});

test("touch rejects another actor's claim", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-t-2");
    await cmd("./cli/commands/take.mjs", dir, ["T-t-2"], { as: "alice" });
    await assert.rejects(
      cmd("./cli/commands/touch.mjs", dir, ["T-t-2"], { as: "bob" }),
      (err) => err.code === "NOT_OWNER",
    );
  } finally { await rmTempProject(dir); }
});

test("touch rejects a task that is not in_progress", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-t-3");
    await assert.rejects(
      cmd("./cli/commands/touch.mjs", dir, ["T-t-3"], { as: "alice" }),
      (err) => err.code === "INVALID_STATUS",
    );
  } finally { await rmTempProject(dir); }
});

test("touch requires --as", async () => {
  const dir = await v2Project();
  await addTask(dir, "T-t-4");
  const saved = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  try {
    await assert.rejects(
      cmd("./cli/commands/touch.mjs", dir, ["T-t-4"], {}),
      (err) => /agent required/.test(err.message),
    );
  } finally {
    if (saved !== undefined) process.env.CLIMIER_AGENT = saved;
    await rmTempProject(dir);
  }
});
