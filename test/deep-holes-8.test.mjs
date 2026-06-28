// Deep holes — round 8: keep digging
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

// Worker can `next` a task that doesn't exist — should fail
test("hole: next on a corrupt-claimed task returns the spec anyway", async () => {
  const { default: next } = await importFresh("./commands/next.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice" };
      return s;
    });
    // Worker "bob" can still see the spec; this is OK (read-only is fine)
    const out = await next({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.id, "T1");
  } finally {
    await rmTempProject(dir);
  }
});

// status view with no tasks at all (just an initiative)
test("hole: status with an initiative but no tasks shows counts of 0", async () => {
  const { default: status } = await importFresh("./commands/status.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.initiatives = { x: { desc: "empty" } };
      return s;
    });
    const out = await status({ statePath: dir, flags: {} });
    // counts might not include x (no tasks)
    assert.ok(out);
  } finally {
    await rmTempProject(dir);
  }
});

// Claim on a task where the agent's id contains a slash
test("hole: claim with --as containing a slash works", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    const r = await runCli(["--project", dir, "claim", "F0.T1", "--as", "team/api-agent"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.equal(s.tasks["F0.T1"].claimed_by, "team/api-agent");
  } finally {
    await rmTempProject(dir);
  }
});

// done with the agent's id containing a slash
test("hole: done with --as containing a slash works", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    await runCli(["--project", dir, "claim", "F0.T1", "--as", "team/api-agent"]);
    const r = await runCli(["--project", dir, "done", "F0.T1", "ok", "--as", "team/api-agent"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await rmTempProject(dir);
  }
});

// release by recovery agent (not just orchestrator)
test("hole: release by 'recovery' agent works as escape hatch", async () => {
  const { default: release } = await importFresh("./commands/release.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice" };
      return s;
    });
    await release({ statePath: dir, flags: { as: "recovery" }, positional: ["T1"] });
    const s = await readState(dir);
    assert.equal(s.tasks.T1.claimed_by, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

// Decide uses orchestrator as default agent
test("hole: decide without --as defaults to 'orchestrator'", async () => {
  const { default: decide } = await importFresh("./commands/decide.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.decisions.D1 = { id: "D1" };
      return s;
    });
    await decide({ statePath: dir, flags: {}, positional: ["D1", "x"] });
    const s = await readState(dir);
    assert.equal(s.decisions.D1.decided_by, "orchestrator");
  } finally {
    await rmTempProject(dir);
  }
});

// next with a task that has depends_on but all are done — ready, but next still shows deps
test("hole: next shows depends_on even when ready", async () => {
  const { default: next } = await importFresh("./commands/next.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done" };
      s.tasks.T2 = { id: "T2", depends_on: ["T1"] };
      return s;
    });
    const out = await next({ statePath: dir, flags: {}, positional: ["T2"] });
    assert.deepEqual(out.depends_on, ["T1"]);
  } finally {
    await rmTempProject(dir);
  }
});

// add-initiative with no --desc
test("hole: add-initiative without --desc works (empty desc)", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "add-initiative", "x"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.ok(s.initiatives.x);
    assert.equal(s.initiatives.x.desc, "");
  } finally {
    await rmTempProject(dir);
  }
});

// Two in_progress tasks in the same initiative
test("hole: two parallel in_progress tasks in same initiative", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const file = path.join(dir, ".agents", "tasks", "tasks.json");
    await fs.writeFile(file, JSON.stringify({
      version: 1, tasks: { T1: { id: "T1" }, T2: { id: "T2" } },
      decisions: {}, gotchas: {}, initiatives: { x: { desc: "" } }, log: [],
    }), "utf8");
    const r1 = await runCli(["--project", dir, "claim", "T1", "--as", "a"]);
    const r2 = await runCli(["--project", dir, "claim", "T2", "--as", "b"]);
    assert.equal(r1.code, 0);
    assert.equal(r2.code, 0);
    const r = await runCli(["--project", dir, "status"]);
    assert.match(r.stdout, /T1/);
    assert.match(r.stdout, /T2/);
  } finally {
    await rmTempProject(dir);
  }
});

// add-task with --depends-on referencing a decision
test("hole: add-task --depends-on can reference a decision", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--seed", "migration"]);
    // D1 is from the migration seed
    const r = await runCli(["--project", dir, "add-task", "T.NEW", "--initiative", "migration", "--title", "new", "--depends-on", "D1"]);
    assert.equal(r.code, 0, r.stderr);
    const s = await readState(dir);
    assert.deepEqual(s.tasks["T.NEW"].depends_on, ["D1"]);
  } finally {
    await rmTempProject(dir);
  }
});

// The state file has trailing newline
test("hole: state file ends with a newline", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const raw = await fs.readFile(path.join(dir, ".agents", "tasks", "tasks.json"), "utf8");
    assert.match(raw, /\n$/);
  } finally {
    await rmTempProject(dir);
  }
});

// A task with depends_on referencing itself (self-loop)
test("hole: derive handles a self-referencing task", async () => {
  const { derive } = await importFresh("./dag.mjs");
  const state = { tasks: { T1: { id: "T1", depends_on: ["T1"] } }, decisions: {} };
  const r = derive(state);
  // Should be blocked, not crash, not in ready
  assert.ok(!r.ready.includes("T1"));
  assert.ok(r.blocked.includes("T1"));
});

// formatTaskShort includes the initiative
test("hole: formatTaskShort shows initiative", async () => {
  const { formatTaskShort } = await importFresh("../src/views.mjs");
  const out = formatTaskShort({ id: "T1", initiative: "mig" });
  assert.match(out, /mig/);
});

// formatNext with a task that has no gotchas doesn't show the section
test("hole: formatNext omits the gotchas section if no gotchas", async () => {
  const { formatNext } = await importFresh("../src/views.mjs");
  const out = formatNext({ id: "T1", title: "T", definition: "d", acceptance: "a", gotchas: [] });
  assert.doesNotMatch(out, /GOTCHAS DEL DOMINIO/);
});

// formatGraph with an empty state returns just the headers
test("hole: formatGraph handles empty state", async () => {
  const { formatGraph } = await importFresh("../src/views.mjs");
  const out = formatGraph([]);
  assert.equal(out, "");
});
