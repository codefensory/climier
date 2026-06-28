// ready view: only claimable-now tasks, with skills/effort/domain/initiative.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("ready: returns only ready tasks with skills/effort/domain/initiative", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "migration", title: "A", skills: ["ts"], effort: "s", domain: "db" };
      s.tasks.T2 = { id: "T2", initiative: "migration", title: "B", skills: ["zod"], effort: "m", domain: "shared" };
      s.tasks.T3 = { id: "T3", initiative: "redesign", title: "C", skills: ["css"], effort: "l", domain: "ui" };
      s.tasks.T4 = { id: "T4", initiative: "migration", title: "D", skills: ["ts"], effort: "m", domain: "auth", depends_on: ["T1"] };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    const ids = out.map((t) => t.id).sort();
    assert.deepEqual(ids, ["T1", "T2", "T3"]); // T4 blocked by T1
    const t1 = out.find((t) => t.id === "T1");
    assert.equal(t1.skills[0], "ts");
    assert.equal(t1.effort, "s");
    assert.equal(t1.domain, "db");
    assert.equal(t1.initiative, "migration");
  } finally {
    await rmTempProject(dir);
  }
});

test("ready: --initiative filter limits results", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", initiative: "migration" };
      s.tasks.T2 = { id: "T2", initiative: "redesign" };
      return s;
    });
    const out = await ready({ statePath: dir, flags: { initiative: "redesign" } });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "T2");
  } finally {
    await rmTempProject(dir);
  }
});

test("ready: empty when nothing claimable", async () => {
  const { default: ready } = await importFresh("./commands/ready.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "x" };
      return s;
    });
    const out = await ready({ statePath: dir, flags: {} });
    assert.equal(out.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});
