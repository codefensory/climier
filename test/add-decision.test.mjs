// add-decision: register a new decision in the state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("add-decision: creates a decision with title and applies_to", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    const { readState } = await importFresh("./state.mjs");
    const out = await addDecision({
      statePath: dir, flags: { title: "pick library", "applies-to": "F9.T1,F9.T2" }, positional: ["D9"],
    });
    assert.equal(out.decision.id, "D9");
    assert.equal(out.decision.title, "pick library");
    assert.deepEqual(out.decision.applies_to, ["F9.T1", "F9.T2"]);
    const s = await readState(dir);
    // open decisions have no status field; "decided" is the only explicit one.
    assert.equal(s.decisions.D9.status, undefined);
    assert.equal(s.decisions.D9.title, "pick library");
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: initiative and description are optional", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    const out = await addDecision({
      statePath: dir, flags: { title: "x", initiative: "research" }, positional: ["D1"],
    });
    assert.equal(out.decision.initiative, "research");
    assert.equal(out.decision.applies_to, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: fails without --title", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      addDecision({ statePath: dir, flags: {}, positional: ["D1"] }),
      /--title required/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: fails without id", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(
      addDecision({ statePath: dir, flags: { title: "x" }, positional: [] }),
      /decision id required/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: fails if decision already exists", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => { s.decisions.D1 = { id: "D1", title: "old" }; return s; });
    await assert.rejects(
      addDecision({ statePath: dir, flags: { title: "new" }, positional: ["D1"] }),
      /already exists/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: applies_to is a CSV list, trimmed and filtered", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    const out = await addDecision({
      statePath: dir, flags: { title: "x", "applies-to": " F1 , F2 ,,F3 " }, positional: ["D1"],
    });
    assert.deepEqual(out.decision.applies_to, ["F1", "F2", "F3"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-decision: empty applies_to stays undefined (not [])", async () => {
  const { default: addDecision } = await importFresh("./commands/add-decision.mjs");
  const dir = await createTempProject();
  try {
    const out = await addDecision({
      statePath: dir, flags: { title: "x", "applies-to": "" }, positional: ["D1"],
    });
    assert.equal(out.decision.applies_to, undefined);
  } finally {
    await rmTempProject(dir);
  }
});
