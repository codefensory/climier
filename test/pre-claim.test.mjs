// pre-claim: read-only pre-flight check before claiming a task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh } from "./helpers.mjs";

test("pre-claim: ready task with no gotchas → can_claim=true, no blockers, no warnings", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "do thing", initiative: "mig", definition: "x", acceptance: "y" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.id, "T1");
    assert.equal(out.derived_status, "ready");
    assert.equal(out.can_claim, true);
    assert.deepEqual(out.blockers, []);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.gotchas.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: ready task with gotchas → can_claim=true but gotchas listed", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "do thing", domain: "db", initiative: "mig" };
      s.gotchas.G1 = { id: "G1", title: "RLS", applies_to: ["domain:db"], mitigation: "filter by user_id", status: "active" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "ready");
    assert.equal(out.can_claim, true);
    assert.equal(out.gotchas.length, 1);
    assert.equal(out.gotchas[0].id, "G1");
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: blocked by unfinished task dep → lists unsatisfied dep", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "first" };
      s.tasks.T2 = { id: "T2", title: "second", depends_on: ["T1"] };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T2"] });
    assert.equal(out.derived_status, "blocked");
    assert.equal(out.can_claim, false);
    assert.equal(out.blockers.length, 1);
    assert.match(out.blockers[0], /T1/);
    assert.match(out.blockers[0], /task: ready|in_progress/);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: blocked by open decision → blockers mentions decision", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "wait for D1", depends_on: ["D1"] };
      s.decisions.D1 = { id: "D1", title: "pick db" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "blocked");
    assert.equal(out.can_claim, false);
    assert.match(out.blockers[0], /D1/);
    assert.match(out.blockers[0], /decision/);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: blocked by unknown dep → blocker flags it as unknown", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", depends_on: ["GHOST"] };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "blocked");
    assert.equal(out.can_claim, false);
    assert.match(out.blockers[0], /GHOST/);
    assert.match(out.blockers[0], /unknown/);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: in_progress task → can_claim=false, claim info present", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", title: "x", status: "in_progress", claimed_by: "alice", claimed_at: Date.now() - 5 * 60 * 1000 };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "in_progress");
    assert.equal(out.can_claim, false);
    assert.equal(out.claim.by, "alice");
    assert.ok(out.claim.age_ms >= 5 * 60 * 1000);
    assert.match(out.blockers[0], /in_progress/);
    assert.match(out.blockers[0], /alice/);
    assert.equal(out.warnings.length, 0);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: stale in_progress task → warning added (default 2h)", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "bob", claimed_at: Date.now() - 3 * 60 * 60 * 1000 };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.can_claim, false);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /stale/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: stale in_progress with --staleMs 0 → still flagged", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "bob", claimed_at: Date.now() - 1000 };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: { staleMs: "0" }, positional: ["T1"] });
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /stale/i);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: in_progress with block_reason surfaces it", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "alice", claimed_at: Date.now(), block_reason: "waiting on infra" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.claim.block_reason, "waiting on infra");
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: done task → can_claim=false, derived_status=done", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "done" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "done");
    assert.equal(out.can_claim, false);
    assert.match(out.blockers[0], /done/);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: archived task → can_claim=false", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "archived" };
      return s;
    });
    const out = await preClaim({ statePath: dir, flags: {}, positional: ["T1"] });
    assert.equal(out.derived_status, "archived");
    assert.equal(out.can_claim, false);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: task not found → throws", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => { s.tasks.T1 = { id: "T1" }; return s; });
    await assert.rejects(preClaim({ statePath: dir, flags: {}, positional: ["NOPE"] }), /not found/);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: missing state → throws", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(preClaim({ statePath: dir, flags: {}, positional: ["T1"] }), /state file missing/);
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: --staleMs with non-numeric value throws clear error", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "bob", claimed_at: Date.now() - 60000 };
      return s;
    });
    await assert.rejects(
      preClaim({ statePath: dir, flags: { staleMs: "foo" }, positional: ["T1"] }),
      /--staleMs must be a non-negative number/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: --staleMs with negative value throws clear error", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    const { updateState } = await importFresh("./state.mjs");
    await updateState(dir, (s) => {
      s.tasks.T1 = { id: "T1", status: "in_progress", claimed_by: "bob", claimed_at: Date.now() - 60000 };
      return s;
    });
    await assert.rejects(
      preClaim({ statePath: dir, flags: { staleMs: "-1" }, positional: ["T1"] }),
      /--staleMs must be a non-negative number/,
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("pre-claim: missing id arg → throws", async () => {
  const { default: preClaim } = await importFresh("./commands/pre-claim.mjs");
  const dir = await createTempProject();
  try {
    await assert.rejects(preClaim({ statePath: dir, flags: {}, positional: [] }), /task id required/);
  } finally {
    await rmTempProject(dir);
  }
});
