// log.mjs: append to the global state log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, writeCanonicalState } from "./helpers.ts";

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

test("append uses a SQLite transaction without rebasing node revisions", async () => {
  const { append } = await importFresh("./storage/log.ts");
  const { readState } = await importFresh("./storage/state.ts");
  const dir = await createTempProject();
  try {
    await writeCanonicalState(dir, {
      version: 1,
      revision: 1,
      nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", title: "keep", status: "open", revision: 1 } },
      edges: [], initiatives: {}, log: [],
    });
    await append(dir, { agent: "a", action: "sqlite-append", task: "T1" });
    const after = await readState(dir);
    assert.equal(after.log.at(-1).action, "sqlite-append");
    assert.equal(after.nodes.T1.revision, 1);
    assert.equal(after.revision, 2);
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
