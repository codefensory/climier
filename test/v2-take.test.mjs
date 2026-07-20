// F9 — `take`: idempotent claim of a ready v2 task.
// First `take` from an agent claims the first alphabetically-sorted ready task
// matching the filters and returns freshly_claimed=true. Subsequent `take`
// calls from the same agent return the same task with freshly_claimed=false.
// ponytail: idempotence is a single in-lock scan over the agent's in_progress
// tasks; adding per-task or per-initiative indices here would be premature.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, runCli, readState } from "./helpers.mjs";

async function v2Project() {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  const dir = await createTempProject();
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
  return dir;
}

async function addInitiative(dir, name, desc = name) {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  await addInit({ statePath: dir, flags: { desc }, positional: [name] });
}

async function addTask(dir, id, extra = {}) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: extra.title || id,
      initiative: extra.initiative || "auth",
      domain: extra.domain,
      tags: extra.tags,
      ...extra,
    },
  });
}

async function take(dir, flags, positional = []) {
  const { default: takeCmd } = await importFresh("./commands/take.mjs");
  return takeCmd({ statePath: dir, flags, positional, projectDir: dir });
}

// --- happy path --------------------------------------------------------

test("take: first call claims a ready task and returns freshly_claimed=true; second call returns same task with freshly_claimed=false", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "Add session middleware", tags: "backend,api" });

    const first = await take(dir, { as: "alice" });
    assert.equal(first.node.id, "T-auth-1");
    assert.equal(first.node.status, "in_progress");
    assert.deepEqual(first.node.claim, { by: "alice", at: first.node.claim.at });
    assert.equal(typeof first.node.claim.at, "string");
    assert.equal(first.freshly_claimed, true);
    assert.equal(first.context.derived_status, "in_progress");
    assert.equal(first.context.claim.by, "alice");
    assert.ok(Array.isArray(first.context.blocking));
    assert.deepEqual(first.context.knowledge, []);

    // revision bumped from 1 (initial) to 2 on claim.
    assert.equal(first.context.revision, 2);

    const second = await take(dir, { as: "alice" });
    assert.equal(second.node.id, "T-auth-1");
    assert.equal(second.freshly_claimed, false);
    // No new state mutation: revision unchanged.
    assert.equal(second.context.revision, 2);
    assert.equal(second.context.claim.by, "alice");
  } finally { await rmTempProject(dir); }
});

// --- selection rule ----------------------------------------------------

test("take: picks the alphabetically-first ready task and skips blocked tasks", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-zeta", { title: "Z task" });
    await addTask(dir, "T-blocker", { title: "Unfinished blocker" });
    await addTask(dir, "T-auth-alpha", { title: "A task", "blocked-by": "T-blocker" });
    await addTask(dir, "T-auth-mike", { title: "M task" });

    const out = await take(dir, { as: "alice" });
    assert.equal(out.node.id, "T-auth-mike");
    assert.equal(out.freshly_claimed, true);
  } finally { await rmTempProject(dir); }
});

// --- no ready tasks ---------------------------------------------------

test("take: throws NOT_READY with code NOT_READY when no task matches", async () => {
  const dir = await v2Project();
  try {
    await assert.rejects(
      take(dir, { as: "alice" }),
      (err) => err.code === "NOT_READY",
    );
  } finally { await rmTempProject(dir); }
});

// --- filters ----------------------------------------------------------

test("take: --initiative only returns tasks of that initiative", async () => {
  const dir = await v2Project();
  try {
    await addInitiative(dir, "billing", "billing");
    await addTask(dir, "T-auth-1", { title: "auth task", initiative: "auth" });
    await addTask(dir, "T-billing-1", { title: "billing task", initiative: "billing" });

    const out = await take(dir, { as: "alice", initiative: "billing" });
    assert.equal(out.node.id, "T-billing-1");
  } finally { await rmTempProject(dir); }
});

test("take: --initiative filter excludes everything when no match", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "auth task", initiative: "auth" });
    await assert.rejects(
      take(dir, { as: "alice", initiative: "ghost" }),
      (err) => err.code === "NOT_READY",
    );
  } finally { await rmTempProject(dir); }
});

test("take: --domain only returns tasks with that domain", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "auth task", domain: "auth" });
    await addTask(dir, "T-auth-2", { title: "data task", domain: "data" });

    const out = await take(dir, { as: "alice", domain: "data" });
    assert.equal(out.node.id, "T-auth-2");
  } finally { await rmTempProject(dir); }
});

test("take: --tag only returns tasks with that tag", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "backend task", tags: "backend,api" });
    await addTask(dir, "T-auth-2", { title: "frontend task", tags: "frontend,ui" });

    const out = await take(dir, { as: "alice", tag: "backend" });
    assert.equal(out.node.id, "T-auth-1");
  } finally { await rmTempProject(dir); }
});

test("take: filter combinations are AND'd", async () => {
  const dir = await v2Project();
  try {
    await addInitiative(dir, "billing", "billing");
    await addTask(dir, "T-1", { title: "auth/backend", initiative: "auth", domain: "auth", tags: "backend" });
    await addTask(dir, "T-2", { title: "billing/backend", initiative: "billing", domain: "billing", tags: "backend" });
    await addTask(dir, "T-3", { title: "auth/frontend", initiative: "auth", domain: "auth", tags: "frontend" });

    const out = await take(dir, { as: "alice", initiative: "auth", domain: "auth", tag: "backend" });
    assert.equal(out.node.id, "T-1");
  } finally { await rmTempProject(dir); }
});

// --- idempotence semantics --------------------------------------------

test("take: idempotence respects filters — agent's existing claim with different initiative is NOT returned", async () => {
  const dir = await v2Project();
  try {
    await addInitiative(dir, "billing", "billing");
    await addTask(dir, "T-auth-1", { title: "auth1", initiative: "auth" });
    await addTask(dir, "T-auth-2", { title: "auth2", initiative: "auth" });
    await addTask(dir, "T-billing-1", { title: "bill1", initiative: "billing" });

    const first = await take(dir, { as: "alice", initiative: "auth" });
    assert.equal(first.node.id, "T-auth-1");

    // Calling take with --initiative billing should NOT return T-auth-1
    // (Alice already owns it but it does not match the filter); pick a
    // billing task instead, freshly claimed.
    const second = await take(dir, { as: "alice", initiative: "billing" });
    assert.equal(second.node.id, "T-billing-1");
    assert.equal(second.freshly_claimed, true);
  } finally { await rmTempProject(dir); }
});

test("take: another agent's in_progress task is invisible to take; second agent picks a different ready task (or errors NOT_READY if none)", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-only", { title: "only one ready" });

    const alice = await take(dir, { as: "alice" });
    assert.equal(alice.node.id, "T-only");
    assert.equal(alice.node.claim.by, "alice");

    // Bob's take with no other ready tasks should get NOT_READY — T-only is
    // not in deriveV2.ready (it's in_progress by Alice), so there's nothing
    // to claim. Bob NEVER sees Alice's task.
    await assert.rejects(
      take(dir, { as: "bob" }),
      (err) => err.code === "NOT_READY",
    );
  } finally { await rmTempProject(dir); }
});

test("take: second agent can claim a different task when another agent holds one", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-aaa");
    await addTask(dir, "T-zzz");

    const alice = await take(dir, { as: "alice" });
    assert.equal(alice.node.id, "T-aaa");

    const bob = await take(dir, { as: "bob" });
    // Bob picks the next alphabetically-first ready task — T-zzz.
    assert.equal(bob.node.id, "T-zzz");
    assert.equal(bob.freshly_claimed, true);
    assert.equal(bob.node.claim.by, "bob");
  } finally { await rmTempProject(dir); }
});

// --- arg validation ----------------------------------------------------

test("take: rejects --as with no value (MISSING_AGENT)", async () => {
  const dir = await v2Project();
  const prev = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  try {
    await assert.rejects(
      take(dir, { as: true }),
      (err) => err.code === "MISSING_AGENT" && /^take:/.test(err.message) && /--as/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
    await rmTempProject(dir);
  }
});

test("take: rejects missing --as (MISSING_AGENT)", async () => {
  const dir = await v2Project();
  const prev = process.env.CLIMIER_AGENT;
  delete process.env.CLIMIER_AGENT;
  try {
    await assert.rejects(
      take(dir, {}),
      (err) => err.code === "MISSING_AGENT" && /^take:/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev;
    await rmTempProject(dir);
  }
});

// --- persistence -------------------------------------------------------

test("take: persists claim = { by, at }, status = 'in_progress', and bumps revision", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "Auth task" });
    await take(dir, { as: "alice" });
    const s = await readState(dir);
    const node = s.nodes["T-auth-1"];
    assert.equal(node.status, "in_progress");
    assert.equal(node.claim.by, "alice");
    assert.ok(typeof node.claim.at === "string" && node.claim.at.length > 0);
    assert.equal(node.revision, 2);
    // Audit log was appended with action=take.
    const last = s.log.at(-1);
    assert.equal(last.action, "take");
    assert.equal(last.agent, "alice");
    assert.equal(last.node, "T-auth-1");
  } finally { await rmTempProject(dir); }
});

// --- CLI smoke ---------------------------------------------------------

test("CLI: take --as agent-x returns node + context + freshly_claimed = true on a fresh v2 project", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "Auth"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task",
      "--title", "Hello",
      "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["--project", dir, "take", "--as", "agent-x"]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.node.id, "T-auth-1");
    assert.equal(out.node.claim.by, "agent-x");
    assert.equal(out.freshly_claimed, true);
    assert.equal(typeof out.context.revision, "number");
    assert.equal(out.context.claim.by, "agent-x");
    assert.deepEqual(out.context.knowledge, []);
    assert.ok(Array.isArray(out.context.blocking));
  } finally { await rmTempProject(dir); }
});

test("CLI: take --as agent-x is idempotent across repeated invocations", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--v2"]);
    await runCli(["--project", dir, "add-initiative", "auth", "--desc", "Auth"]);
    await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task",
      "--title", "Hello", "--initiative", "auth",
    ]);

    const r1 = await runCli(["--project", dir, "take", "--as", "agent-x"]);
    assert.equal(r1.code, 0, r1.stderr);
    const r2 = await runCli(["--project", dir, "take", "--as", "agent-x"]);
    assert.equal(r2.code, 0, r2.stderr);

    const first = JSON.parse(r1.stdout);
    const second = JSON.parse(r2.stdout);
    assert.equal(first.node.id, "T-auth-1");
    assert.equal(second.node.id, "T-auth-1");
    assert.equal(first.freshly_claimed, true);
    assert.equal(second.freshly_claimed, false);
  } finally { await rmTempProject(dir); }
});
