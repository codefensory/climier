// TDD for ADR-022 piece 2: submit/accept archive claim.meta; reject/reopen clean it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

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

test("submit archives claim.meta to submitted_meta and clears claim", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-a-1");
    await cmd("./cli/commands/take.mjs", dir, ["T-a-1"], { as: "alice", meta: '{"pid":7}' });
    const out = await cmd("./cli/commands/submit.mjs", dir, ["T-a-1"], { as: "alice", note: "done work" });
    assert.equal(out.node.claim, null);
    assert.deepEqual(out.node.submitted_meta, { pid: 7 });
    assert.equal(out.node.submitted_by, "alice");
  } finally { await rmTempProject(dir); }
});

test("submit without claim.meta leaves submitted_meta null", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-a-2");
    await cmd("./cli/commands/take.mjs", dir, ["T-a-2"], { as: "alice" });
    const out = await cmd("./cli/commands/submit.mjs", dir, ["T-a-2"], { as: "alice", note: "w" });
    assert.equal(out.node.submitted_meta, null);
  } finally { await rmTempProject(dir); }
});

test("accept archives submitted_meta to accepted_meta", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-a-3");
    await cmd("./cli/commands/take.mjs", dir, ["T-a-3"], { as: "alice", meta: '{"pid":9}' });
    await cmd("./cli/commands/submit.mjs", dir, ["T-a-3"], { as: "alice", note: "w" });
    const out = await cmd("./cli/commands/accept.mjs", dir, ["T-a-3"], { as: "bob" });
    assert.equal(out.node.status, "done");
    assert.deepEqual(out.node.submitted_meta, { pid: 9 });
    assert.deepEqual(out.node.accepted_meta, { pid: 9 });
  } finally { await rmTempProject(dir); }
});

test("reject clears attempt meta", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-a-4");
    await cmd("./cli/commands/take.mjs", dir, ["T-a-4"], { as: "alice", meta: '{"pid":1}' });
    await cmd("./cli/commands/submit.mjs", dir, ["T-a-4"], { as: "alice", note: "w" });
    const out = await cmd("./cli/commands/reject.mjs", dir, ["T-a-4"], { as: "bob", reason: "nope" });
    assert.equal(out.node.status, "open");
    assert.equal(out.node.claim, null);
    assert.equal(out.node.submitted_meta, null);
    assert.equal(out.node.accepted_meta, null);
  } finally { await rmTempProject(dir); }
});

test("reopen clears attempt meta", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-a-5");
    await cmd("./cli/commands/take.mjs", dir, ["T-a-5"], { as: "alice", meta: '{"pid":2}' });
    await cmd("./cli/commands/submit.mjs", dir, ["T-a-5"], { as: "alice", note: "w" });
    await cmd("./cli/commands/accept.mjs", dir, ["T-a-5"], { as: "bob" });
    const out = await cmd("./cli/commands/reopen.mjs", dir, ["T-a-5"], { as: "bob", reason: "regression" });
    assert.equal(out.node.status, "open");
    assert.equal(out.node.submitted_meta, null);
    assert.equal(out.node.accepted_meta, null);
  } finally { await rmTempProject(dir); }
});
