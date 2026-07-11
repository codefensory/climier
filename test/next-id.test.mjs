// next-id: pure function + command. Suggests the next free task id for a phase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState } from "./helpers.mjs";

// --- pure function: nextTaskId(state, phase) ---

test("nextTaskId: empty state -> phase.T1", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1"), "F1.T1");
});

test("nextTaskId: phase with T1,T2 -> T3 (next sequential)", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F1.T1": { id: "F1.T1" }, "F1.T2": { id: "F1.T2" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1"), "F1.T3");
});

test("nextTaskId: phase with a gap (T1, T3) -> T4, not T2 (next sequential, not fill)", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F1.T1": { id: "F1.T1" }, "F1.T3": { id: "F1.T3" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1"), "F1.T4");
});

test("nextTaskId: phase with only .OPEN placeholder -> T1 (OPEN doesn't count)", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F2.OPEN": { id: "F2.OPEN" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F2"), "F2.T1");
});

test("nextTaskId: other phases don't interfere", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F0.T1": { id: "F0.T1" }, "F0.T2": { id: "F0.T2" },
    "F1.T1": { id: "F1.T1" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1"), "F1.T2");
  assert.equal(nextTaskId(s, "F0"), "F0.T3");
});

test("nextTaskId: ids without a matching phase prefix are ignored", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "auth-jwt-validate": { id: "auth-jwt-validate" },
    "F1.T1": { id: "F1.T1" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1"), "F1.T2");
});

test("nextTaskId: full phase (T1..T5) -> T6", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F1.T1": { id: "F1.T1" }, "F1.T2": { id: "F1.T2" }, "F1.T3": { id: "F1.T3" },
    "F1.T4": { id: "F1.T4" }, "F1.T5": { id: "F1.T5" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1"), "F1.T6");
});

// --- with --suffix (appended at the end) ---

test("nextTaskId: empty state with suffix R -> phase.T1R", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1", "R"), "F1.T1R");
});

test("nextTaskId: default (no suffix) and R families are independent", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F1.T1": { id: "F1.T1" }, "F1.T1R": { id: "F1.T1R" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1"), "F1.T2");
  assert.equal(nextTaskId(s, "F1", "R"), "F1.T2R");
});

test("nextTaskId: with suffix R, gaps in default family don't bleed into R", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F1.T1": { id: "F1.T1" }, "F1.T3": { id: "F1.T3" },  // gap T2
    "F1.T1R": { id: "F1.T1R" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1", "R"), "F1.T2R");
  assert.equal(nextTaskId(s, "F1"), "F1.T4"); // default family still goes to T4
});

test("nextTaskId: with suffix, .OPEN still ignored", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F1.OPEN": { id: "F1.OPEN" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1", "R"), "F1.T1R");
});

test("nextTaskId: rejects empty suffix", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.throws(() => nextTaskId(s, "F1", ""), /suffix/i);
});

test("nextTaskId: rejects suffix containing a dot", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {}, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.throws(() => nextTaskId(s, "F1", "R.1"), /suffix/i);
});

test("nextTaskId: works with multi-char suffixes (e.g. SPIKE)", async () => {
  const { nextTaskId } = await importFresh("../src/dag.mjs");
  const s = { version: 1, tasks: {
    "F1.T1SPIKE": { id: "F1.T1SPIKE" },
  }, decisions: {}, gotchas: {}, initiatives: {}, log: [] };
  assert.equal(nextTaskId(s, "F1", "SPIKE"), "F1.T2SPIKE");
  assert.equal(nextTaskId(s, "F1"), "F1.T1");
});

// --- command: climier next-id <phase> ---

test("next-id: command returns the next free id for a phase", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("../src/state.mjs");
    await updateState(dir, (s) => {
      s.tasks["F1.T1"] = { id: "F1.T1" };
      s.tasks["F1.T2"] = { id: "F1.T2" };
      return s;
    });
    const out = await nextId({ statePath: dir, flags: {}, positional: ["F1"] });
    assert.equal(out.next, "F1.T3");
  } finally {
    await rmTempProject(dir);
  }
});

test("next-id: empty state returns phase.T1", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("../src/state.mjs");
    await updateState(dir, (s) => s);
    const out = await nextId({ statePath: dir, flags: {}, positional: ["F5"] });
    assert.equal(out.next, "F5.T1");
  } finally {
    await rmTempProject(dir);
  }
});

test("next-id: fails without a phase", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(nextId({ statePath: dir, flags: {}, positional: [] }), /phase required/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("next-id: does not mutate the state", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("../src/state.mjs");
    await updateState(dir, (s) => {
      s.tasks["F1.T1"] = { id: "F1.T1" };
      return s;
    });
    const before = await readState(dir);
    await nextId({ statePath: dir, flags: {}, positional: ["F1"] });
    const after = await readState(dir);
    assert.deepEqual(after, before);
  } finally {
    await rmTempProject(dir);
  }
});

test("next-id --suffix R: returns F1.T1R for an empty R family", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("../src/state.mjs");
    await updateState(dir, (s) => {
      s.tasks["F1.T1"] = { id: "F1.T1" };
      s.tasks["F1.T2"] = { id: "F1.T2" };
      return s;
    });
    const out = await nextId({ statePath: dir, flags: { suffix: "R" }, positional: ["F1"] });
    assert.equal(out.next, "F1.T1R");
  } finally {
    await rmTempProject(dir);
  }
});

test("next-id --suffix R: default and R families are independent", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("../src/state.mjs");
    await updateState(dir, (s) => {
      s.tasks["F1.T1"] = { id: "F1.T1" };
      s.tasks["F1.T1R"] = { id: "F1.T1R" };
      s.tasks["F1.T2R"] = { id: "F1.T2R" };
      return s;
    });
    const outT = await nextId({ statePath: dir, flags: {}, positional: ["F1"] });
    const outR = await nextId({ statePath: dir, flags: { suffix: "R" }, positional: ["F1"] });
    assert.equal(outT.next, "F1.T2");
    assert.equal(outR.next, "F1.T3R");
  } finally {
    await rmTempProject(dir);
  }
});

test("next-id --suffix: rejects empty suffix", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      nextId({ statePath: dir, flags: { suffix: "" }, positional: ["F1"] }),
      /suffix/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("next-id --suffix: rejects suffix with a dot", async () => {
  const { default: nextId } = await importFresh("../src/commands/next-id.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      nextId({ statePath: dir, flags: { suffix: "R.1" }, positional: ["F1"] }),
      /suffix/i,
    );
  } finally {
    await rmTempProject(dir);
  }
});
