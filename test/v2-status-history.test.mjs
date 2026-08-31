// F12 — v2 status, history, deprecate-knowledge.
//
// Three concerns:
//   1. `deprecate-knowledge` mutates a knowledge node (status=deprecated,
//      reasons, agent, revision++; refuses non-knowledge).
//   2. `history <id>` returns log entries that reference the id; empty array
//      when none match.
//   3. `status` on v2 returns the new summary-shape: {summary, tasks, gates,
//      knowledge_count, alerts}; --kind knowledge (or --all) dumps knowledge;
//      filters narrow scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState as readRawState, writeState as writeRawState, runCli } from "./helpers.mjs";

async function bootstrapV2(dir, initName) {
  if (initName === undefined) initName = "work";
  const { default: init } = await importFresh("./cli/commands/init.mjs");
  const { default: addInitiative } = await importFresh("./cli/commands/add-initiative.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInitiative({ statePath: dir, flags: { desc: "test" }, positional: [initName] });
}

async function addGate(dir, id, extra) {
  extra = extra || {};
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "gate",
      title: extra.title || id,
      initiative: extra.initiative || "work",
      body: extra.body || "b",
      purpose: extra.purpose || "decision",
      "resolution-mode": extra["resolution-mode"] || "choice",
      status: extra.status,
      choice: extra.choice,
      rationale: extra.rationale,
    },
  });
}

async function addTask(dir, id, extra) {
  extra = extra || {};
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: extra.title || id,
      initiative: extra.initiative || "work",
      body: extra.body || "b",
      acceptance: extra.acceptance || "a",
      "blocked-by": extra["blocked-by"] || "",
      domain: extra.domain,
      tags: extra.tags,
      as: "seed",
    },
  });
}

async function addKnowledge(dir, id, extra) {
  extra = extra || {};
  const { default: addNode } = await importFresh("./cli/commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "knowledge",
      title: extra.title || id,
      initiative: extra.initiative || "work",
      body: extra.body || "k",
      "scope-domains": extra.domain || "work",
      "knowledge-type": extra["knowledge-type"] || "warning",
      mitigation: extra.mitigation,
      as: "seed",
    },
  });
}

async function v2Status(dir, flags) {
  flags = flags || {};
  const { default: status } = await importFresh("./cli/commands/status.mjs");
  return status({ statePath: dir, flags, positional: [] });
}

async function v2Deprecate(dir, id, flags) {
  flags = flags || {};
  const { default: deprecate } = await importFresh("./cli/commands/deprecate-knowledge.mjs");
  return deprecate({ statePath: dir, positional: [id], flags });
}

async function v2History(dir, id, flags) {
  flags = flags || {};
  const { default: hist } = await importFresh("./cli/commands/history.mjs");
  return hist({ statePath: dir, positional: [id], flags });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("status: v2 returns summary-shape with empty defaults", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    const out = await v2Status(dir);
    assert.deepEqual(out.summary, {
      ready: 0,
      in_progress: 0,
      submitted: 0,
      blocked: 0,
      backlog: 0,
      open_gates: 0,
      active_knowledge: 0,
    });
    assert.deepEqual(out.tasks, { ready: [], in_progress: [], submitted: [], blocked: [], backlog: [] });
    assert.deepEqual(out.gates, { open: [] });
    assert.equal(out.knowledge_count, 0);
    assert.deepEqual(out.alerts, []);
  } finally { await rmTempProject(dir); }
});

test("status: submitted tasks have an explicit bucket and respect filters and limits", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-submitted", { title: "submitted", domain: "validation" });
    await addTask(dir, "T-other", { title: "other", domain: "other" });
    const state = await readRawState(dir);
    state.nodes["T-submitted"].status = "submitted";
    state.nodes["T-other"].status = "submitted";
    await writeRawState(dir, state);

    const out = await v2Status(dir, { domain: "validation", status: "submitted", limit: 1 });
    assert.equal(out.summary.submitted, 1);
    assert.equal(out.tasks.submitted.length, 1);
    assert.equal(out.tasks.submitted[0].id, "T-submitted");
    assert.deepEqual(out.tasks.ready, []);
    assert.deepEqual(out.tasks.blocked, []);

    const all = await v2Status(dir, { all: true });
    assert.equal(all.summary.submitted, 2);
    assert.deepEqual(all.tasks.submitted.map((task) => task.id), ["T-submitted", "T-other"]);
  } finally { await rmTempProject(dir); }
});

test("status: --kind knowledge dumps knowledge items when --all is set", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addKnowledge(dir, "K-foo", { domain: "auth", title: "Foo knowledge", "knowledge-type": "warning" });
    await addKnowledge(dir, "K-bar", { domain: "auth", title: "Bar knowledge", "knowledge-type": "tip" });

    const out = await v2Status(dir, { all: true });
    assert.ok(Array.isArray(out.knowledge), "--all dumps actual knowledge items");
    assert.equal(out.knowledge.length, 2);
    assert.equal(out.knowledge_count, 2);
    const ids = out.knowledge.map((k) => k.id).sort();
    assert.deepEqual(ids, ["K-bar", "K-foo"]);
    // The default `active_knowledge` count is 2 (no deprecations yet).
    assert.equal(out.summary.active_knowledge, 2);
  } finally { await rmTempProject(dir); }
});

test("status: --kind knowledge alone does not dump items (count only)", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addKnowledge(dir, "K-foo", { domain: "auth" });
    const out = await v2Status(dir, { kind: "knowledge" });
    assert.equal(typeof out.knowledge, "undefined", "no knowledge array unless --all");
    assert.equal(out.knowledge_count, 1);
    assert.equal(out.summary.active_knowledge, 1);
  } finally { await rmTempProject(dir); }
});

test("status: --initiative filters the nodes", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir, "work");
    const { default: addInitiative } = await importFresh("./cli/commands/add-initiative.mjs");
    await addInitiative({ statePath: dir, flags: { desc: "other" }, positional: ["other"] });
    await addTask(dir, "T-work", { initiative: "work", title: "W" });
    await addTask(dir, "T-other", { initiative: "other", title: "O" });

    const out = await v2Status(dir, { initiative: "other" });
    assert.equal(out.summary.ready, 1);
    assert.equal(out.tasks.ready.length, 1);
    assert.equal(out.tasks.ready[0].id, "T-other");
  } finally { await rmTempProject(dir); }
});

test("status: in_progress visibility is global by default; --as does not restrict", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-a", { title: "a" });
    await addTask(dir, "T-b", { title: "b" });
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({ statePath: dir, projectDir: dir, flags: { as: "alice" }, positional: ["T-a"] });
    await take({ statePath: dir, projectDir: dir, flags: { as: "bob" }, positional: ["T-b"] });

    // No --as, no --claimed-by: every in_progress task is listed and counted.
    const all = await v2Status(dir);
    assert.equal(all.summary.in_progress, 2,
      `expected summary.in_progress=2 by default; got ${all.summary.in_progress}`);
    assert.equal(all.tasks.in_progress.length, 2);
    const owners = all.tasks.in_progress.map((t) => t.claimed_by).sort();
    assert.deepEqual(owners, ["alice", "bob"]);

    // --as is an identity tag, not a filter: alice still sees both claims.
    const alice = await v2Status(dir, { as: "alice" });
    assert.equal(alice.summary.in_progress, 2,
      `expected summary.in_progress=2 with --as alice; got ${alice.summary.in_progress}`);
    assert.equal(alice.tasks.in_progress.length, 2);
  } finally { await rmTempProject(dir); }
});

test("status: --claimed-by X narrows in_progress to one agent", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-a", { title: "a" });
    await addTask(dir, "T-b", { title: "b" });
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({ statePath: dir, projectDir: dir, flags: { as: "alice" }, positional: ["T-a"] });
    await take({ statePath: dir, projectDir: dir, flags: { as: "bob" }, positional: ["T-b"] });

    const aliceOnly = await v2Status(dir, { "claimed-by": "alice" });
    assert.equal(aliceOnly.summary.in_progress, 1);
    assert.equal(aliceOnly.tasks.in_progress.length, 1);
    assert.equal(aliceOnly.tasks.in_progress[0].claimed_by, "alice");

    const bobOnly = await v2Status(dir, { "claimed-by": "bob" });
    assert.equal(bobOnly.summary.in_progress, 1);
    assert.equal(bobOnly.tasks.in_progress[0].claimed_by, "bob");
  } finally { await rmTempProject(dir); }
});

test("status: in_progress honors --status (in_progress shows all; other values leave it empty)", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-a", { title: "a" });
    await addTask(dir, "T-b", { title: "b" });
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({ statePath: dir, projectDir: dir, flags: { as: "alice" }, positional: ["T-a"] });
    await take({ statePath: dir, projectDir: dir, flags: { as: "bob" }, positional: ["T-b"] });

    const ip = await v2Status(dir, { status: "in_progress" });
    assert.equal(ip.summary.in_progress, 2);
    assert.equal(ip.tasks.in_progress.length, 2);

    const open = await v2Status(dir, { status: "open" });
    assert.equal(open.summary.in_progress, 0);
    assert.deepEqual(open.tasks.in_progress, []);

    const done = await v2Status(dir, { status: "done" });
    assert.equal(done.summary.in_progress, 0);
    assert.deepEqual(done.tasks.in_progress, []);
  } finally { await rmTempProject(dir); }
});

test("status: in_progress list honors --limit", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    for (const id of ["T-a", "T-b", "T-c"]) {
      await addTask(dir, id, { title: id });
    }
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({ statePath: dir, projectDir: dir, flags: { as: "alice" }, positional: ["T-a"] });
    await take({ statePath: dir, projectDir: dir, flags: { as: "bob" }, positional: ["T-b"] });
    await take({ statePath: dir, projectDir: dir, flags: { as: "carol" }, positional: ["T-c"] });

    const out = await v2Status(dir, { limit: 2 });
    assert.equal(out.summary.in_progress, 3,
      "summary count is unaffected by --limit; only the list is capped");
    assert.equal(out.tasks.in_progress.length, 2,
      "list respects --limit");
  } finally { await rmTempProject(dir); }
});

test("status: in_progress list honors --initiative (and --as does not re-scope)", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    const { default: addInitiative } = await importFresh("./cli/commands/add-initiative.mjs");
    await addInitiative({ statePath: dir, flags: { desc: "other" }, positional: ["other"] });
    await addTask(dir, "T-w", { title: "w", initiative: "work" });
    await addTask(dir, "T-o", { title: "o", initiative: "other" });
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({ statePath: dir, projectDir: dir, flags: { as: "alice" }, positional: ["T-w"] });
    await take({ statePath: dir, projectDir: dir, flags: { as: "bob" }, positional: ["T-o"] });

    const work = await v2Status(dir, { initiative: "work" });
    assert.equal(work.summary.in_progress, 1);
    assert.equal(work.tasks.in_progress[0].id, "T-w");
    assert.equal(work.tasks.in_progress[0].initiative, "work");

    const other = await v2Status(dir, { initiative: "other", as: "alice" });
    assert.equal(other.summary.in_progress, 1,
      "--as must not restrict; --initiative does");
    assert.equal(other.tasks.in_progress[0].id, "T-o");
  } finally { await rmTempProject(dir); }
});

test("status: stale-claim alerts are global by default; --claimed-by X narrows them", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-a", { title: "a" });
    await addTask(dir, "T-b", { title: "b" });
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({ statePath: dir, projectDir: dir, flags: { as: "alice" }, positional: ["T-a"] });
    await take({ statePath: dir, projectDir: dir, flags: { as: "bob" }, positional: ["T-b"] });

    // --stale-ms 0 forces every in_progress claim to be stale.
    const all = await v2Status(dir, { "stale-ms": 0 });
    const staleAlerts = all.alerts.filter((a) => a.kind === "stale-claim");
    assert.equal(staleAlerts.length, 2,
      `expected 2 stale-claim alerts by default; got ${staleAlerts.length}`);

    const aliceOnly = await v2Status(dir, { "claimed-by": "alice", "stale-ms": 0 });
    const aliceAlerts = aliceOnly.alerts.filter((a) => a.kind === "stale-claim");
    assert.equal(aliceAlerts.length, 1);
    assert.equal(aliceAlerts[0].claimed_by, "alice");

    const aliceViaAs = await v2Status(dir, { as: "alice", "stale-ms": 0 });
    const aliceViaAsAlerts = aliceViaAs.alerts.filter((a) => a.kind === "stale-claim");
    assert.equal(aliceViaAsAlerts.length, 2,
      "--as must not narrow stale-claim alerts either");
  } finally { await rmTempProject(dir); }
});

test("status: --all includes done groups and alerts", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addGate(dir, "G-done", { status: "resolved", choice: "yes", rationale: "ok" });
    await addTask(dir, "T-z", { title: "z" });
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    const first = await take({ statePath: dir, projectDir: dir, flags: { as: "alice" }, positional: ["T-z"] });
    // Flip status by hand because this test exercises the status view, not
    // the resolve command.
    const state = await readRawState(dir);
    const tId = first.node.id;
    state.nodes[tId].status = "done";
    state.nodes[tId].revision = (state.nodes[tId].revision || 1) + 1;
    const { writeState } = await import("./helpers.mjs");
    await writeState(dir, state);

    const out = await v2Status(dir, { all: true });
    assert.equal(typeof out.done, "object", "done groups present when --all");
    assert.ok(Array.isArray(out.done.tasks), "done tasks listed");
    assert.equal(out.done.tasks.length, 1);
  } finally { await rmTempProject(dir); }
});

test("status: blocked reports unsatisfied BLOCKS", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addGate(dir, "G-1", { title: "g1" });
    await addTask(dir, "T-1", { title: "t1", "blocked-by": "G-1" });

    const out = await v2Status(dir);
    assert.equal(out.summary.blocked, 1);
    assert.equal(out.tasks.blocked.length, 1);
    assert.equal(out.tasks.blocked[0].id, "T-1");
    assert.deepEqual(out.summary, {
      ready: 0,
      in_progress: 0,
      submitted: 0,
      blocked: 1,
      backlog: 0,
      open_gates: 1,
      active_knowledge: 0,
    });
  } finally { await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// deprecate-knowledge
// ---------------------------------------------------------------------------

test("deprecate-knowledge: happy path sets fields, bumps revision, logs", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addKnowledge(dir, "K-1", { title: "Foo", domain: "auth" });

    const out = await v2Deprecate(dir, "K-1", { reason: "obsolete after rollout", as: "alice" });
    assert.equal(out.node.id, "K-1");
    assert.equal(out.node.status, "deprecated");
    assert.equal(out.node.deprecation_reason, "obsolete after rollout");
    assert.equal(out.node.deprecated_by, "alice");
    assert.equal(typeof out.node.deprecated_at, "string");
    assert.ok(out.node.deprecated_at.endsWith("Z") || out.node.deprecated_at.includes("T"), "ISO timestamp");
    assert.equal(out.node.revision, 2);

    const state = await readRawState(dir);
    const lastLog = state.log[state.log.length - 1];
    assert.equal(lastLog.action, "deprecate-knowledge");
    assert.equal(lastLog.node, "K-1");
    assert.equal(lastLog.agent, "alice");
    assert.equal(lastLog.reason, "obsolete after rollout");
  } finally { await rmTempProject(dir); }
});

test("deprecate-knowledge: missing --reason throws MISSING_FIELD", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addKnowledge(dir, "K-1", { domain: "auth" });
    await assert.rejects(
      v2Deprecate(dir, "K-1", { as: "alice" }),
      (err) => err.code === "MISSING_FIELD" && err.details.field === "reason",
    );
  } finally { await rmTempProject(dir); }
});

test("deprecate-knowledge: missing --as throws MISSING_AGENT", async () => {
  const dir = await createTempProject();
  let prev;
  try {
    await bootstrapV2(dir);
    await addKnowledge(dir, "K-1", { domain: "auth" });
    // drop the env-var fallback that helpers.mjs set, so MISSING_AGENT wins.
    prev = process.env.CLIMIER_AGENT;
    delete process.env.CLIMIER_AGENT;
    await assert.rejects(
      v2Deprecate(dir, "K-1", { reason: "x" }),
      (err) => err.code === "MISSING_AGENT",
    );
  } finally {
    if (prev !== undefined) process.env.CLIMIER_AGENT = prev;
    await rmTempProject(dir);
  }
});

test("deprecate-knowledge: rejects non-knowledge node with INVALID_EDGE_KIND", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-1", { title: "task" });
    await assert.rejects(
      v2Deprecate(dir, "T-1", { reason: "x", as: "alice" }),
      (err) => err.code === "INVALID_EDGE_KIND" && /knowledge/.test(err.message),
    );
  } finally { await rmTempProject(dir); }
});

test("deprecate-knowledge: unknown id throws NODE_NOT_FOUND", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await assert.rejects(
      v2Deprecate(dir, "K-missing", { reason: "x", as: "alice" }),
      (err) => err.code === "NODE_NOT_FOUND" && err.details.id === "K-missing",
    );
  } finally { await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test("history: returns matching log entries referencing the id", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-1", { title: "t1" });
    const { default: addNote } = await importFresh("./cli/commands/add-note.mjs");
    await addNote({ statePath: dir, positional: ["T-1", "first thought"], flags: { as: "alice" } });
    await addNote({ statePath: dir, positional: ["T-1", "second thought"], flags: { as: "alice" } });

    const out = await v2History(dir, "T-1");
    assert.equal(out.id, "T-1");
    assert.ok(Array.isArray(out.entries));
    // add-node + 2 add-notes all reference T-1 (the add-node entry's `note`
    // is the id by design; both add-note entries carry `node: T-1`).
    assert.equal(out.entries.length, 3);
    for (const e of out.entries) {
      const haystack = [e.node, e.task, e.decision, e.gotcha, e.note].filter(Boolean).join(" ");
      assert.ok(haystack.includes("T-1"), `expected log entry to reference T-1 (got ${JSON.stringify(e)})`);
    }
  } finally { await rmTempProject(dir); }
});

test("history: empty entries for an unknown node id", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-1", { title: "t1" });
    const out = await v2History(dir, "K-nothing");
    assert.deepEqual(out, { id: "K-nothing", entries: [] });
  } finally { await rmTempProject(dir); }
});

test("history: --limit caps results but stays in chronological order", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await addTask(dir, "T-1", { title: "t1" });
    const { default: addNote } = await importFresh("./cli/commands/add-note.mjs");
    for (let i = 0; i < 5; i++) {
      await addNote({ statePath: dir, positional: ["T-1", `note ${i}`], flags: { as: "alice" } });
    }
    const out = await v2History(dir, "T-1", { limit: 2 });
    assert.equal(out.entries.length, 2);
    // chronological: oldest first; we want the LATEST two (most recent), so the
    // last two notes ("note 3" then "note 4").
    assert.match(out.entries[0].note, /note 3/);
    assert.match(out.entries[1].note, /note 4/);
  } finally { await rmTempProject(dir); }
});

test("history: missing id is a clear error", async () => {
  const dir = await createTempProject();
  try {
    await bootstrapV2(dir);
    await assert.rejects(
      v2History(dir, undefined, {}),
      (err) => /history/.test(err.message) && /id/i.test(err.message),
    );
  } finally { await rmTempProject(dir); }
});

// ---------------------------------------------------------------------------
// bin routing (CLI end-to-end)
// ---------------------------------------------------------------------------

test("CLI: status routes to v2-shape on a v2 state", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "work", "--desc", "x", "--as", "test-agent"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-knowledge", "K-1", "--initiative", "work", "--title", "k", "--body", "k", "--scope-domains", "w", "--as", "test-agent"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "status"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok("summary" in data);
    assert.equal(typeof data.summary.ready, "number");
    assert.equal(data.knowledge_count, 1);
    assert.equal(typeof data.knowledge, "undefined", "no knowledge array unless --all");
  } finally { await rmTempProject(dir); }
});

test("CLI: deprecate-knowledge routes and writes log entry via the bin", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    await runCli(["--project", dir, "add-initiative", "work", "--desc", "x", "--as", "test-agent"]);
    await runCli([
      "--project", dir, "add-knowledge", "K-1",
      "--initiative", "work", "--title", "k", "--body", "k", "--scope-domains", "w",
      "--as", "test-agent",
    ]);
    const r = await runCli([
      "--project", dir, "deprecate-knowledge", "K-1",
      "--reason", "obsolete", "--as", "alice",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.node.status, "deprecated");
    assert.equal(data.node.deprecation_reason, "obsolete");
    assert.equal(data.node.deprecated_by, "alice");
    // history picks up the new log entry
    const h = await runCli(["--project", dir, "history", "K-1"]);
    assert.equal(h.code, 0, h.stderr);
    const histData = JSON.parse(h.stdout);
    assert.equal(histData.id, "K-1");
    assert.ok(histData.entries.some((e) => e.action === "deprecate-knowledge" && e.reason === "obsolete"));
  } finally { await rmTempProject(dir); }
});

test("CLI: history on v1 state returns the same envelope, no crash", async () => {
  const dir = await createTempProject();
  try {
    await runCli(["--project", dir, "init"]);
    const r = await runCli(["--project", dir, "history", "F0.T1"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data, { id: "F0.T1", entries: [] });
  } finally { await rmTempProject(dir); }
});
