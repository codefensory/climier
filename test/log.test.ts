// log.mjs: append to the global state log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.ts";

test("append adds an entry with ts, agent, action", async () => {
  const { append } = await importFresh("./storage/log.ts");
  const { readState: rs } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await append(dir, { agent: "agent-1", action: "claim", task: "T1" });
    const s = await rs(dir);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].agent, "agent-1");
    assert.equal(s.log[0].action, "claim");
    assert.equal(s.log[0].task, "T1");
    assert.ok(s.log[0].ts);
  } finally {
    await rmTempProject(dir);
  }
});

test("append adds multiple entries in order", async () => {
  const { append } = await importFresh("./storage/log.ts");
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await append(dir, { agent: "a", action: "claim", task: "T1" });
    await append(dir, { agent: "a", action: "done", task: "T1" });
    const s = await readState(dir);
    assert.equal(s.log.length, 2);
    assert.equal(s.log[0].action, "claim");
    assert.equal(s.log[1].action, "done");
  } finally {
    await rmTempProject(dir);
  }
});

test("append commits to the ledger without rebasing node revisions", async () => {
  const { append } = await importFresh("./storage/log.ts");
  const { bootstrapFencedState, readFencedState, commitFencedStateUnderLock } = await importFresh("./storage/ledger.ts");
  const { withLock } = await import("../src/storage/lock.ts");
  const dir = await createTempProject();
  try {
    const before = await bootstrapFencedState(dir);
    const seeded = { ...before, nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", title: "keep", status: "open", revision: before.revision + 1 } }, revision: before.revision + 1 };
    await withLock(dir, (lockContext) => commitFencedStateUnderLock(lockContext, seeded));
    const committed = await readFencedState(dir);
    await append(dir, { agent: "a", action: "ledger-append", task: "T1" });
    const after = await readFencedState(dir);
    assert.equal(after.log.at(-1).action, "ledger-append");
    assert.equal(after.nodes.T1.revision, committed.nodes.T1.revision);
    assert.equal(after.revision, committed.revision + 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("append accepts a note field", async () => {
  const { append } = await importFresh("./storage/log.ts");
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await append(dir, { agent: "a", action: "done", task: "T1", note: "all good" });
    const s = await readState(dir);
    assert.equal(s.log[0].note, "all good");
  } finally {
    await rmTempProject(dir);
  }
});
