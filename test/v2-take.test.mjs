// F9 — `take <id>`: idempotent claim of an explicit ready v2 task.
// First `take <id>` from an agent claims that task and returns
// freshly_claimed=true. Repeating the same id as the same agent returns it
// with freshly_claimed=false. Legacy filters are accepted but ignored.

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

async function take(dir, id, flags) {
  const { default: takeCmd } = await importFresh("./commands/take.mjs");
  return takeCmd({ statePath: dir, flags, positional: [id], projectDir: dir });
}

// --- happy path --------------------------------------------------------

test("take: first call claims a ready task and returns freshly_claimed=true; second call returns same task with freshly_claimed=false", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "Add session middleware", tags: "backend,api" });

    const first = await take(dir, "T-auth-1", { as: "alice" });
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

    const second = await take(dir, "T-auth-1", { as: "alice" });
    assert.equal(second.node.id, "T-auth-1");
    assert.equal(second.freshly_claimed, false);
    // No new state mutation: revision unchanged.
    assert.equal(second.context.revision, 2);
    assert.equal(second.context.claim.by, "alice");
  } finally { await rmTempProject(dir); }
});

// --- selection rule ----------------------------------------------------

test("take: claims the explicitly requested ready task instead of auto-selecting", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-zeta", { title: "Z task" });
    await addTask(dir, "T-blocker", { title: "Unfinished blocker" });
    await addTask(dir, "T-auth-alpha", { title: "A task", "blocked-by": "T-blocker" });
    await addTask(dir, "T-auth-mike", { title: "M task" });

    const out = await take(dir, "T-auth-zeta", { as: "alice" });
    assert.equal(out.node.id, "T-auth-zeta");
    assert.equal(out.freshly_claimed, true);
  } finally { await rmTempProject(dir); }
});

// --- no ready tasks ---------------------------------------------------

test("take: throws NOT_READY when the requested task is blocked", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-blocker");
    await addTask(dir, "T-blocked", { "blocked-by": "T-blocker" });
    await assert.rejects(
      take(dir, "T-blocked", { as: "alice" }),
      (err) => err.code === "NOT_READY",
    );
  } finally { await rmTempProject(dir); }
});

// --- filters ----------------------------------------------------------

test("take: accepts and ignores --initiative", async () => {
  const dir = await v2Project();
  try {
    await addInitiative(dir, "billing", "billing");
    await addTask(dir, "T-auth-1", { title: "auth task", initiative: "auth" });
    await addTask(dir, "T-billing-1", { title: "billing task", initiative: "billing" });

    const out = await take(dir, "T-auth-1", { as: "alice", initiative: "billing" });
    assert.equal(out.node.id, "T-auth-1");
  } finally { await rmTempProject(dir); }
});

test("take: an unmatched --initiative does not exclude the explicit id", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "auth task", initiative: "auth" });
    const out = await take(dir, "T-auth-1", { as: "alice", initiative: "ghost" });
    assert.equal(out.node.id, "T-auth-1");
  } finally { await rmTempProject(dir); }
});

test("take: accepts and ignores --domain", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "auth task", domain: "auth" });
    await addTask(dir, "T-auth-2", { title: "data task", domain: "data" });

    const out = await take(dir, "T-auth-1", { as: "alice", domain: "data" });
    assert.equal(out.node.id, "T-auth-1");
  } finally { await rmTempProject(dir); }
});

test("take: accepts and ignores --tag", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1", { title: "backend task", tags: "backend,api" });
    await addTask(dir, "T-auth-2", { title: "frontend task", tags: "frontend,ui" });

    const out = await take(dir, "T-auth-2", { as: "alice", tag: "backend" });
    assert.equal(out.node.id, "T-auth-2");
  } finally { await rmTempProject(dir); }
});

test("take: accepts and ignores legacy filter combinations", async () => {
  const dir = await v2Project();
  try {
    await addInitiative(dir, "billing", "billing");
    await addTask(dir, "T-1", { title: "auth/backend", initiative: "auth", domain: "auth", tags: "backend" });
    await addTask(dir, "T-2", { title: "billing/backend", initiative: "billing", domain: "billing", tags: "backend" });
    await addTask(dir, "T-3", { title: "auth/frontend", initiative: "auth", domain: "auth", tags: "frontend" });

    const out = await take(dir, "T-3", { as: "alice", initiative: "billing", domain: "billing", tag: "backend" });
    assert.equal(out.node.id, "T-3");
  } finally { await rmTempProject(dir); }
});

// --- idempotence semantics --------------------------------------------

test("take: explicit id wins over the agent's existing claim", async () => {
  const dir = await v2Project();
  try {
    await addInitiative(dir, "billing", "billing");
    await addTask(dir, "T-auth-1", { title: "auth1", initiative: "auth" });
    await addTask(dir, "T-auth-2", { title: "auth2", initiative: "auth" });
    await addTask(dir, "T-billing-1", { title: "bill1", initiative: "billing" });

    const first = await take(dir, "T-auth-1", { as: "alice", initiative: "auth" });
    assert.equal(first.node.id, "T-auth-1");

    const second = await take(dir, "T-billing-1", { as: "alice", initiative: "auth" });
    assert.equal(second.node.id, "T-billing-1");
    assert.equal(second.freshly_claimed, true);
  } finally { await rmTempProject(dir); }
});

test("take: another agent cannot take the explicit in-progress task", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-only", { title: "only one ready" });

    const alice = await take(dir, "T-only", { as: "alice" });
    assert.equal(alice.node.id, "T-only");
    assert.equal(alice.node.claim.by, "alice");

    await assert.rejects(
      take(dir, "T-only", { as: "bob" }),
      (err) => err.code === "ALREADY_CLAIMED",
    );
  } finally { await rmTempProject(dir); }
});

test("take: second agent can claim a different task when another agent holds one", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-aaa");
    await addTask(dir, "T-zzz");

    const alice = await take(dir, "T-aaa", { as: "alice" });
    assert.equal(alice.node.id, "T-aaa");

    const bob = await take(dir, "T-zzz", { as: "bob" });
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
      take(dir, "T-auth-1", { as: true }),
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
      take(dir, "T-auth-1", {}),
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
    await take(dir, "T-auth-1", { as: "alice" });
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

test("CLI: take <id> --as agent-x returns node + context + freshly_claimed = true on a fresh v2 project", async () => {
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

    r = await runCli(["--project", dir, "take", "T-auth-1", "--as", "agent-x"]);
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

test("CLI: take <id> --as agent-x is idempotent across repeated invocations", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init", "--v2"]);
    await runCli(["--project", dir, "add-initiative", "auth", "--desc", "Auth"]);
    await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task",
      "--title", "Hello", "--initiative", "auth",
    ]);

    const r1 = await runCli(["--project", dir, "take", "T-auth-1", "--as", "agent-x"]);
    assert.equal(r1.code, 0, r1.stderr);
    const r2 = await runCli(["--project", dir, "take", "T-auth-1", "--as", "agent-x"]);
    assert.equal(r2.code, 0, r2.stderr);

    const first = JSON.parse(r1.stdout);
    const second = JSON.parse(r2.stdout);
    assert.equal(first.node.id, "T-auth-1");
    assert.equal(second.node.id, "T-auth-1");
    assert.equal(first.freshly_claimed, true);
    assert.equal(second.freshly_claimed, false);
  } finally { await rmTempProject(dir); }
});
