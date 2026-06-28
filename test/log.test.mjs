// log.mjs: append to the global state log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("append adds an entry with ts, agent, action", async () => {
  const { append, readState } = await importFresh("./log.mjs");
  const { readState: rs } = await importFresh("./state.mjs");
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
  const { append } = await importFresh("./log.mjs");
  const { readState } = await importFresh("./state.mjs");
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

test("append accepts a note field", async () => {
  const { append } = await importFresh("./log.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    await append(dir, { agent: "a", action: "done", task: "T1", note: "all good" });
    const s = await readState(dir);
    assert.equal(s.log[0].note, "all good");
  } finally {
    await rmTempProject(dir);
  }
});
