// release: free a claim without completing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("release: clears claim, task returns to ready, log entry", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const { readState } = await importFresh("./state.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "agent-a", claimed_at: Date.now() };
      return s;
    });
    await release({ statePath: dir, flags: { as: "agent-a" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.claimed_by, undefined);
    assert.equal(s.tasks.T1.claimed_at, undefined);
    assert.equal(s.tasks.T1.status, undefined); // back to "ready" (derived)
    const entry = s.log.find((e) => e.action === "release" && e.task === "T1");
    assert.ok(entry);
  } finally {
    await rmTempProject(dir);
  }
});

test("release: fails if not claimed by this agent", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "agent-x" };
      return s;
    });
    await assert.rejects(release({ statePath: dir, flags: { as: "agent-y" }, positional: ["T1"] }));
  } finally {
    await rmTempProject(dir);
  }
});

test("release: fails if not in_progress", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1" };
      return s;
    });
    await assert.rejects(release({ statePath: dir, flags: { as: "a" }, positional: ["T1"] }));
  } finally {
    await rmTempProject(dir);
  }
});
