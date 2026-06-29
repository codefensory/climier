// bare --as (no value) should fail with a clear error, not silently set as=true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

async function setup(dir) {
  const { updateState } = await importFresh("./state.mjs");
  await updateState(dir, (s) => {
    s.tasks.T1 = { id: "T1", title: "x" };
    s.decisions.D1 = { id: "D1", title: "y" };
    return s;
  });
}

test("claim: bare --as (no value) throws clear error", async () => {
  const { default: claim } = await importFresh("./commands/claim.mjs");
  const dir = await createTempProject();
  try {
    await setup(dir);
    await assert.rejects(
      claim({ statePath: dir, flags: { as: true }, positional: ["T1"] }),
      /--as requires a value/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("done: bare --as throws clear error", async () => {
  const { default: done } = await importFresh("./commands/done.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice", claimed_at: Date.now() };
      return s;
    });
    await assert.rejects(
      done({ statePath: dir, flags: { as: true }, positional: ["T1", "shipped"] }),
      /--as requires a value/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("release: bare --as throws clear error", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice", claimed_at: Date.now() };
      return s;
    });
    await assert.rejects(
      release({ statePath: dir, flags: { as: true }, positional: ["T1"] }),
      /--as requires a value/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("block: bare --as throws clear error", async () => {
  const { default: block } = await importFresh("./commands/block.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice", claimed_at: Date.now() };
      return s;
    });
    await assert.rejects(
      block({ statePath: dir, flags: { as: true }, positional: ["T1", "need help"] }),
      /--as requires a value/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("decide: bare --as throws clear error (does NOT default to orchestrator)", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    await setup(dir);
    await assert.rejects(
      decide({ statePath: dir, flags: { as: true }, positional: ["D1", "pick X"] }),
      /--as requires a value/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("decide: missing --as still defaults to orchestrator (no regression)", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    await setup(dir);
    const out = await decide({ statePath: dir, flags: {}, positional: ["D1", "pick X"] });
    assert.equal(out.decision.decided_by, "orchestrator");
  } finally {
    await rmTempProject(dir);
  }
});
