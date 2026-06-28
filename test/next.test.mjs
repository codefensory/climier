// next: definition + acceptance + domain gotchas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("next: returns id, title, definition, acceptance, gotchas", async () => {
  const { default: next } = await importFresh("./commands/next.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = {
        id: "T1",
        title: "Set up DB",
        domain: "db",
        acceptance: "schema applied; smoke test green",
      };
      s.gotchas.G1 = { id: "G1", title: "RLS", applies_to: ["domain:db"], mitigation: "filter by user_id", status: "active" };
      return s;
    });
    const out = await next({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.id, "T1");
    assert.equal(out.title, "Set up DB");
    assert.match(out.acceptance, /schema applied/);
    assert.ok(out.gotchas.length >= 1);
    assert.equal(out.gotchas[0].id, "G1");
  } finally {
    await rmTempProject(dir);
  }
});

test("next: fails if task not found", async () => {
  const { default: next } = await importFresh("./commands/next.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(next({ statePath: dir, flags: {}, positional: ["NOPE"] }));
  } finally {
    await rmTempProject(dir);
  }
});
