// close-gotcha: mark a gotcha as resolved so it stops surfacing in forTask/views.
// A resolved gotcha is soft-deleted: the node stays in the state for audit,
// but views filter it out. Reopen with `reopen-gotcha`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

test("close-gotcha: sets status=resolved", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"] };
      return s;
    });
    const out = await closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    assert.equal(out.gotcha.status, "resolved");
    const s = await readState(dir);
    assert.equal(s.gotchas.G1.status, "resolved");
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: hides the gotcha from forTask", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const { forTask } = await importFresh("./gotchas.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "t", domain: "db" };
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"] };
      return s;
    });
    const before = await readState(dir);
    assert.equal(forTask(before, before.tasks.T1).length, 1);
    await closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    const s = await readState(dir);
    assert.equal(forTask(s, s.tasks.T1).length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: hides the gotcha from the gotchas view", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const { default: gotchasView } = await importFresh("./commands/gotchas.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "open", applies_to: ["domain:db"] };
      s.gotchas.G2 = { id: "G2", title: "open2", applies_to: ["domain:db"] };
      return s;
    });
    assert.equal((await gotchasView({ statePath: dir, flags: {} })).length, 2);
    await closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    const out = await gotchasView({ statePath: dir, flags: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "G2");
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: appends a log entry with action=close-gotcha", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"] };
      return s;
    });
    await closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    const s = await readState(dir);
    const last = s.log[s.log.length - 1];
    assert.equal(last.action, "close-gotcha");
    assert.equal(last.agent, "alice");
    assert.equal(last.gotcha, "G1");
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: is idempotent (closing a resolved gotcha is a no-op)", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"], status: "resolved" };
      return s;
    });
    const out = await closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    assert.equal(out.gotcha.status, "resolved");
    // No log entry: nothing changed.
    const s = await readState(dir);
    assert.equal(s.log.filter((e) => e.action === "close-gotcha").length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: requires --as", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"] };
      return s;
    });
    await assert.rejects(
      closeGotcha({ statePath: dir, flags: {}, positional: ["G1"] }),
      /--as/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: requires a gotcha id", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: [] }),
      /id required/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: fails on unknown gotcha", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"] };
      return s;
    });
    await assert.rejects(
      closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["NOPE"] }),
      /not found/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("close-gotcha: works on a gotcha that already has a non-resolved status field", async () => {
  const { default: closeGotcha } = await importFresh("./commands/close-gotcha.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.gotchas.G1 = { id: "G1", title: "trap", applies_to: ["domain:db"], status: "active" };
      return s;
    });
    const out = await closeGotcha({ statePath: dir, flags: { as: "alice" }, positional: ["G1"] });
    assert.equal(out.gotcha.status, "resolved");
  } finally {
    await rmTempProject(dir);
  }
});
