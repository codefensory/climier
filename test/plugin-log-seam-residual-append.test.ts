// appendWithContext unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.ts";

test("appendWithContext: adds plugin_id when ctx.pluginId is a non-empty string", async () => {
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
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
  const { appendWithContext } = await importFresh("./storage/log.ts");
  const dir = await createTempProject();
  try {
    const entry: Record<string, unknown> = { agent: "alice", action: "add-task", node: "T1" };
    await appendWithContext(dir, entry, { pluginId: "example.audit" });
    assert.equal(entry.plugin_id, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
