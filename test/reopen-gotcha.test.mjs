// reopen-gotcha: undo a close. Removes the resolved status so the gotcha
// surfaces again in forTask/views. Mirrors the task reopen pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

test("reopen-gotcha: removes status from a resolved gotcha", async () => {
  const { default: reopenGotcha } = await importFresh("./commands/reopen-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"], status: "resolved" };
      return s;
    });
    const out = await reopenGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    assert.equal(out.gotcha.status, undefined);
    const s = await readState(dir);
    assert.equal(s.gotchas.G1.status, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen-gotcha: makes the gotcha reappear in forTask", async () => {
  const { default: reopenGotcha } = await importFresh("./commands/reopen-gotcha.mjs");
  const { forTask } = await importFresh("./gotchas.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", domain: "db" };
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"], status: "resolved" };
      return s;
    });
    assert.equal(forTask(await readState(dir), (await readState(dir)).tasks.T1).length, 0);
    await reopenGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    const s = await readState(dir);
    assert.equal(forTask(s, s.tasks.T1).length, 1);
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen-gotcha: appends a log entry with action=reopen-gotcha", async () => {
  const { default: reopenGotcha } = await importFresh("./commands/reopen-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"], status: "resolved" };
      return s;
    });
    await reopenGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.equal(last.action, "reopen-gotcha");
    assert.equal(last.agent, "alice");
    assert.equal(last.gotcha, "G1");
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen-gotcha: is a no-op on a gotcha that is not resolved", async () => {
  const { default: reopenGotcha } = await importFresh("./commands/reopen-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"] };
      return s;
    });
    const out = await reopenGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    assert.equal(out.gotcha.status, undefined);
    const s = await readState(dir);
    assert.equal(s.log.filter((e) => e.action === "reopen-gotcha").length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen-gotcha: requires --as", async () => {
  const { default: reopenGotcha } = await importFresh("./commands/reopen-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"], status: "resolved" };
      return s;
    });
    await assert.rejects(
      reopenGotcha({ statePath: dir, flags: {}, positional: ["G1"] }),
      /--as/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen-gotcha: requires a gotcha id", async () => {
  const { default: reopenGotcha } = await importFresh("./commands/reopen-gotcha.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      reopenGotcha({ statePath: dir, flags: { as: "alice" }, positional: [] }),
      /id required/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen-gotcha: fails on unknown gotcha", async () => {
  const { default: reopenGotcha } = await importFresh("./commands/reopen-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"], status: "resolved" };
      return s;
    });
    await assert.rejects(
      reopenGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["NOPE"] }),
      /not found/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});
