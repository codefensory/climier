// F13 — v2 adversarial test pass.
//
// Goal: surface root-cause bugs in the v2 surface by exercising edges the
// existing suites don't probe. Each describe block names the bug class. A
// failing test is a real bug to fix; a passing test pins the contract.
//
// Conventions:
//   - one temp project per `it` (no shared state across cases)
//   - env mutations are wrapped in try/finally so they never leak
//   - one small focused assertion per `it`
//   - structural failures (NODE_NOT_FOUND, REVISION_CONFLICT) assert
//     err.code AND err.details, not just the message text
//
// The existing suite already covers the happy paths; this file probes
// the awkward corners: status filter asymmetry, silent flag drops,
// concurrent reads/writes, and validation gaps.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  runCli,
  writeState as writeRawState,
  readState as readRawState,
} from "./helpers.mjs";

// --- shared scaffolding ------------------------------------------------

async function freshV2(dir) {
  const { default: init } = await importFresh("./commands/init.mjs");
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
}

async function addInit(dir, name = "auth", desc = "auth") {
  const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
  await addInit({ statePath: dir, flags: { desc }, positional: [name] });
}

async function addTaskNode(dir, id, extra = {}) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: id,
      initiative: "auth",
      ...extra,
    },
  });
}

async function addGateNode(dir, id, extra = {}) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "gate",
      title: id,
      initiative: "auth",
      purpose: "decision",
      ...extra,
    },
  });
}

async function addKnowledgeNode(dir, id, extra = {}) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "knowledge",
      title: id,
      initiative: "auth",
      body: extra.body || "default body",
      ...extra,
    },
  });
}

async function takeNode(dir, id, as) {
  const { default: take } = await importFresh("./commands/take.mjs");
  return take({ statePath: dir, flags: { as }, positional: [id], projectDir: dir });
}

async function resolveTask(dir, id, as, note = "shipped") {
  const { default: resolve } = await importFresh("./commands/v2-resolve.mjs");
  return resolve({ statePath: dir, flags: { as, note }, positional: [id] });
}

async function v2Project() {
  const dir = await createTempProject();
  await freshV2(dir);
  await addInit(dir);
  return dir;
}

// =====================================================================
// Class A — v2-status filter coverage
//
// The status filter MUST apply to every bucket. Today it only filters
// ready/blocked/backlog (the post-derived pools). The in_progress bucket
// is derived from the persistent `node.status` and never sees the filter.
// That makes `--status ready --as alice` return alice's in_progress in
// summary.in_progress, which contradicts the user's expectation.
// =====================================================================

describe("v2-status: --status filter applies to ALL buckets (not just derived)", () => {
  test("--status ready with a claimed in_progress task: summary.in_progress is 0 (not the claimer's count)", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await addTaskNode(dir, "T-b");
      await takeNode(dir, "T-a", "alice");
      // Two tasks; one is in_progress (claimed by alice), one is ready.
      const { default: status } = await importFresh("./commands/v2-status.mjs");
      const out = await status({
        statePath: dir,
        flags: { status: "ready", as: "alice" },
      });
      assert.equal(out.summary.in_progress, 0,
        `expected in_progress=0 when --status ready; got ${JSON.stringify(out.summary)}`);
      assert.equal(out.summary.ready, 1);
      assert.deepEqual(out.tasks.in_progress, []);
    } finally { await rmTempProject(dir); }
  });

  test("--status done with an in_progress task: tasks.in_progress is empty", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await takeNode(dir, "T-a", "alice");
      const { default: status } = await importFresh("./commands/v2-status.mjs");
      const out = await status({
        statePath: dir,
        flags: { status: "done", as: "alice" },
      });
      // --status done should NOT show in_progress items.
      assert.equal(out.summary.in_progress, 0,
        `summary.in_progress must be 0 when --status done; got ${out.summary.in_progress}`);
      assert.deepEqual(out.tasks.in_progress, []);
    } finally { await rmTempProject(dir); }
  });

  test("--status in_progress returns exactly the in_progress tasks in the bucket (no scoping by --as)", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await addTaskNode(dir, "T-b");
      await takeNode(dir, "T-a", "alice");
      await takeNode(dir, "T-b", "bob");
      const { default: status } = await importFresh("./commands/v2-status.mjs");
      const out = await status({
        statePath: dir,
        flags: { status: "in_progress" },
      });
      // No --as / no --claimed-by: should still surface the in_progress bucket
      // because the user explicitly asked for it.
      assert.equal(out.summary.in_progress, 2,
        `expected summary.in_progress=2 with --status in_progress (no --as); got ${out.summary.in_progress}`);
      assert.equal(out.tasks.in_progress.length, 2);
    } finally { await rmTempProject(dir); }
  });

  test("--status open hides in_progress from the summary count", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await takeNode(dir, "T-a", "alice");
      const { default: status } = await importFresh("./commands/v2-status.mjs");
      const out = await status({ statePath: dir, flags: { status: "open" } });
      assert.equal(out.summary.in_progress, 0,
        `summary.in_progress must be 0 when --status open; got ${out.summary.in_progress}`);
      assert.equal(out.summary.ready, 0,
        `summary.ready must be 0 when the only task is in_progress (not open); got ${out.summary.ready}`);
    } finally { await rmTempProject(dir); }
  });

  test("--status on open_gates: filters by status", async () => {
    const dir = await v2Project();
    try {
      await addGateNode(dir, "G-a");
      await addGateNode(dir, "G-b");
      // Resolve G-b to leave one open gate.
      const { default: resolve } = await importFresh("./commands/v2-resolve.mjs");
      await resolve({ statePath: dir, flags: { as: "alice", choice: "yes", rationale: "ok" }, positional: ["G-b"] });
      const { default: status } = await importFresh("./commands/v2-status.mjs");
      const out = await status({ statePath: dir, flags: { status: "open" } });
      // open gates should be included; resolved should not.
      assert.equal(out.summary.open_gates, 1,
        `expected open_gates=1 when --status open (G-a open, G-b resolved); got ${out.summary.open_gates}`);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class B — silent flag drops in add-task v2
//
// add-task.mjs lists `--depends-on` in knownFlags but the v2 path
// (which delegates to add-node) does NOT propagate it. So a user calling
// `add-task T-x --initiative auth --title t --body b --acceptance a
//  --depends-on T-y` on a v2 state silently creates an unrelated task
// with no BLOCKS edge. That's data loss without a warning.
// =====================================================================

describe("add-task v2: --depends-on must NOT be silently dropped", () => {
  test("add-task v2 --depends-on T-y: rejects explicitly with structured error (not silently dropped)", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-y");
      // v2 path requires body+acceptance AND --blocked-by. Pass them.
      // --depends-on is v1 vocabulary; v2 should reject it explicitly.
      let caught;
      try {
        const { default: addTask } = await importFresh("./commands/add-task.mjs");
        await addTask({
          statePath: dir,
          flags: {
            initiative: "auth",
            title: "x",
            body: "b",
            acceptance: "a",
            "blocked-by": "",
            "depends-on": "T-y",
            as: "alice",
          },
          positional: ["T-x"],
        });
      } catch (e) { caught = e; }
      assert.ok(caught, "add-task v2 --depends-on must throw, not silently drop");
      assert.match(caught.message, /depends-on.*v1|--blocked-by/);
      const s = await readRawState(dir);
      // No partial mutation: T-x must not exist and no edges added.
      assert.equal(s.nodes["T-x"], undefined,
        `add-task v2 must not create T-x when --depends-on is rejected; got ${JSON.stringify(s.nodes["T-x"])}`);
      assert.equal(s.edges.length, 0, `no edges should be added on rejection; got ${JSON.stringify(s.edges)}`);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class C — search edge cases
//
// search.mjs does case-insensitive substring matching, but the user's
// query is sent through `.toLowerCase()` only on the call side; the
// matched text is also `.toLowerCase()`-ed, so the .includes is literal.
// However, regex metacharacters MUST NOT act as regex — `.includes` is
// already literal, so this test pins that contract.
// =====================================================================

describe("search: regex metacharacters are literal (no regex engine)", () => {
  test("search '.' matches a literal dot, not 'any char'", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2,
        nodes: {
          "K-x": {
            id: "K-x", kind: "knowledge", title: "v1.2 release",
            body: "we shipped v1.2", initiative: "auth",
            scope: { tags: [] }, status: "active",
          },
          "K-y": {
            id: "K-y", kind: "knowledge", title: "alpha release",
            body: "we shipped the alpha", initiative: "auth",
            scope: { tags: [] }, status: "active",
          },
        },
        edges: [],
        initiatives: { auth: { desc: "auth" } },
        log: [],
      });
      const { default: search } = await importFresh("./commands/search.mjs");
      const out = await search({ statePath: dir, positional: ["v1.2"], flags: {} });
      assert.equal(out.count, 1, "literal '.' must NOT match every character");
      assert.equal(out.matches[0].id, "K-x");
    } finally { await rmTempProject(dir); }
  });

  test("search '.*' matches the literal substring, not 'anything'", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2,
        nodes: {
          "K-x": {
            id: "K-x", kind: "knowledge", title: "regex literal",
            body: "this body contains the literal '.*'", initiative: "auth",
            scope: { tags: [] }, status: "active",
          },
          "K-y": {
            id: "K-y", kind: "knowledge", title: "other",
            body: "no special here", initiative: "auth",
            scope: { tags: [] }, status: "active",
          },
        },
        edges: [],
        initiatives: { auth: { desc: "auth" } },
        log: [],
      });
      const { default: search } = await importFresh("./commands/search.mjs");
      const out = await search({ statePath: dir, positional: [".*"], flags: {} });
      // Only K-x has ".*" in any field.
      assert.equal(out.count, 1, "literal '.*' must NOT match everything");
      assert.equal(out.matches[0].id, "K-x");
    } finally { await rmTempProject(dir); }
  });

  test("search empty query returns empty result (does not error)", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2, nodes: {}, edges: [], initiatives: {}, log: [],
      });
      const { default: search } = await importFresh("./commands/search.mjs");
      const out = await search({ statePath: dir, positional: [""], flags: {} });
      assert.deepEqual(out, { matches: [], count: 0 });
    } finally { await rmTempProject(dir); }
  });

  test("search unicode body: matches a unicode substring", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2,
        nodes: {
          "K-unicode": {
            id: "K-unicode", kind: "knowledge", title: "alpha",
            body: "we should respect ñoño and 漢字", initiative: "auth",
            scope: { tags: [] }, status: "active",
          },
        },
        edges: [],
        initiatives: { auth: { desc: "auth" } },
        log: [],
      });
      const { default: search } = await importFresh("./commands/search.mjs");
      const out1 = await search({ statePath: dir, positional: ["ñoño"], flags: {} });
      assert.equal(out1.count, 1);
      const out2 = await search({ statePath: dir, positional: ["漢字"], flags: {} });
      assert.equal(out2.count, 1);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class D — history envelope consistency
//
// history.mjs returns { id, entries: [] } for a v2 state. It must not
// crash on a missing id, on a missing state file, or on a non-matching id.
// The `entry.note` tokenization must NOT match substrings — only full
// whitespace-delimited tokens. (E.g. a task T1 should NOT match the
// note "T10 because of T11".)
// =====================================================================

describe("history: tokenization matches whole id only", () => {
  test("history T1 does NOT match a log note 'T10 because of T11'", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2,
        nodes: {},
        edges: [],
        initiatives: {},
        log: [
          { ts: new Date().toISOString(), agent: "alice", action: "add-edge", note: "T10 BLOCKS T11" },
        ],
      });
      const { default: history } = await importFresh("./commands/history.mjs");
      const out = await history({ statePath: dir, positional: ["T1"], flags: {} });
      assert.equal(out.entries.length, 0,
        `history T1 must not match note "T10 BLOCKS T11" (substring false positive)`);
    } finally { await rmTempProject(dir); }
  });

  test("history T1 DOES match a log note that lists T1 as a whole token", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2,
        nodes: {},
        edges: [],
        initiatives: {},
        log: [
          { ts: new Date().toISOString(), agent: "alice", action: "add-edge", note: "T10 BLOCKS T1" },
          { ts: new Date().toISOString(), agent: "alice", action: "update", node: "T1" },
        ],
      });
      const { default: history } = await importFresh("./commands/history.mjs");
      const out = await history({ statePath: dir, positional: ["T1"], flags: {} });
      // The second entry has node === T1 (match).
      // The first entry's note "T10 BLOCKS T1" has T1 as a whole token (match).
      assert.equal(out.entries.length, 2,
        `expected 2 matches for T1; got ${out.entries.length}`);
    } finally { await rmTempProject(dir); }
  });

  test("history returns {id, entries: []} on missing state file", async () => {
    const dir = await createTempProject();
    try {
      // No writeState — state file is absent.
      const { default: history } = await importFresh("./commands/history.mjs");
      const out = await history({ statePath: dir, positional: ["T-x"], flags: {} });
      assert.deepEqual(out, { id: "T-x", entries: [] });
    } finally { await rmTempProject(dir); }
  });

  test("history rejects missing id", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2, nodes: {}, edges: [], initiatives: {}, log: [],
      });
      const { default: history } = await importFresh("./commands/history.mjs");
      let caught;
      try { await history({ statePath: dir, positional: [], flags: {} }); }
      catch (e) { caught = e; }
      assert.ok(caught, "history without id must throw");
      assert.match(caught.message, /id required/);
    } finally { await rmTempProject(dir); }
  });

  test("history --limit caps the entries returned (most-recent N)", async () => {
    const dir = await createTempProject();
    try {
      await writeRawState(dir, {
        version: 2,
        nodes: {},
        edges: [],
        initiatives: {},
        log: Array.from({ length: 10 }, (_, i) => ({
          ts: new Date(Date.now() + i * 1000).toISOString(),
          agent: "alice",
          action: "update",
          node: "T1",
        })),
      });
      const { default: history } = await importFresh("./commands/history.mjs");
      const out = await history({ statePath: dir, positional: ["T1"], flags: { limit: "3" } });
      assert.equal(out.entries.length, 3);
      // Last 3 entries should be the most recent (ts at index 7, 8, 9 of the seed).
      assert.equal(out.entries[0].action, "update");
      assert.ok(out.entries[out.entries.length - 1].ts >= out.entries[0].ts,
        `expected entries in non-decreasing ts order; got ${out.entries.map((e) => e.ts).join(", ")}`);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class E — concurrent ops on the same node
//
// Two processes operating on the same node should serialize cleanly via
// the file lock. The contract: one wins, the other observes the new
// state. No partial writes. No torn revisions. No lost log entries.
// =====================================================================

describe("concurrency: two operations on the same node serialize cleanly", () => {
  test("two takes on the same task: one claims, the other sees ALREADY_CLAIMED", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const a = runCli(["--project", dir, "take", "T-a", "--as", "alice"]);
      const b = runCli(["--project", dir, "take", "T-a", "--as", "bob"]);
      const [ra, rb] = await Promise.all([a, b]);
      const codes = [ra.code, rb.code].sort();
      assert.deepEqual(codes, [0, 1], `expected one 0 and one 1; got A=${ra.code} B=${rb.code}; A stdout=${ra.stdout} B stdout=${rb.stdout}`);
      const s = await readRawState(dir);
      // Lock order is non-deterministic; the winner is whichever process
      // acquired the lock first. The loser must observe the winner's claim.
      const winner = s.nodes["T-a"].claim.by;
      assert.ok(["alice", "bob"].includes(winner), `winner must be alice or bob; got ${winner}`);
      // Revision bumped exactly once (1 → 2 on take).
      assert.equal(s.nodes["T-a"].revision, 2);
      // The loser's stdout must report ALREADY_CLAIMED.
      const loserOut = ra.code === 1 ? ra.stdout : rb.stdout;
      const loserErr = JSON.parse(loserOut);
      assert.equal(loserErr.error.code, "ALREADY_CLAIMED");
      assert.equal(loserErr.error.details.owner, winner);
    } finally { await rmTempProject(dir); }
  });

  test("concurrent updates on the same node: revision bumps twice; both writes apply", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const a = runCli(["--project", dir, "update", "T-a", "--title", "from alice", "--as", "alice"]);
      const b = runCli(["--project", dir, "update", "T-a", "--title", "from bob", "--as", "bob"]);
      await Promise.all([a, b]);
      const s = await readRawState(dir);
      // Both updates apply (last-write-wins); revision incremented exactly twice
      // from the initial 1 → 3.
      assert.ok(["from alice", "from bob"].includes(s.nodes["T-a"].title),
        `expected one of the two titles; got ${s.nodes["T-a"].title}`);
      assert.equal(s.nodes["T-a"].revision, 3, `expected revision 3 after two updates; got ${s.nodes["T-a"].revision}`);
      // Both log entries present.
      const updates = s.log.filter((e) => e.action === "update");
      assert.equal(updates.length, 2, `expected 2 update log entries; got ${updates.length}`);
    } finally { await rmTempProject(dir); }
  });

  test("concurrent take+resolve on the same task: claimer wins; racy non-owner gets NOT_OWNER", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await takeNode(dir, "T-a", "alice");
      const a = runCli(["--project", dir, "resolve", "T-a", "--note", "done", "--as", "alice"]);
      const b = runCli(["--project", dir, "resolve", "T-a", "--note", "done", "--as", "bob"]);
      const [ra, rb] = await Promise.all([a, b]);
      // One succeeds (alice), one fails (bob — NOT_OWNER).
      const codes = [ra.code, rb.code].sort();
      assert.deepEqual(codes, [0, 1]);
      const s = await readRawState(dir);
      assert.equal(s.nodes["T-a"].status, "done");
      assert.equal(s.nodes["T-a"].done_by, "alice");
    } finally { await rmTempProject(dir); }
  });

  test("concurrent add-edge on the same pair: exactly one DUPLICATE_EDGE", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await addTaskNode(dir, "T-b");
      const a = runCli(["--project", dir, "add-edge", "T-a", "T-b", "--type", "BLOCKS", "--as", "alice"]);
      const b = runCli(["--project", dir, "add-edge", "T-a", "T-b", "--type", "BLOCKS", "--as", "alice"]);
      const [ra, rb] = await Promise.all([a, b]);
      const codes = [ra.code, rb.code].sort();
      assert.deepEqual(codes, [0, 1], `expected one 0 and one 1; got A=${ra.code} B=${rb.code}; A stdout=${ra.stdout} B stdout=${rb.stdout}`);
      const s = await readRawState(dir);
      const matchingEdges = s.edges.filter(
        (edge) => edge.from === "T-a" && edge.to === "T-b" && edge.type === "BLOCKS",
      );
      assert.equal(matchingEdges.length, 1, `expected exactly one edge; got ${matchingEdges.length}`);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class F — idempotency edges
//
// add-note with the same text twice should create two notes (audit log
// is append-only by design). add-edge with the same triple should
// DUPLICATE_EDGE. add-initiative on v2 should ID_CONFLICT. These tests
// pin each contract so any drift is caught.
// =====================================================================

describe("idempotency contracts", () => {
  test("add-note: identical text twice creates two notes (audit, not dedupe)", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const { default: addNote } = await importFresh("./commands/add-note.mjs");
      await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T-a", "hello"] });
      await addNote({ statePath: dir, flags: { as: "alice" }, positional: ["T-a", "hello"] });
      const s = await readRawState(dir);
      assert.equal(s.nodes["T-a"].notes.length, 2);
      assert.equal(s.nodes["T-a"].notes[0].text, "hello");
      assert.equal(s.nodes["T-a"].notes[1].text, "hello");
    } finally { await rmTempProject(dir); }
  });

  test("add-edge: same (from,to,type) twice throws DUPLICATE_EDGE", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await addTaskNode(dir, "T-b");
      const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
      await addEdge({ statePath: dir, positional: ["T-a", "T-b"], flags: { type: "BLOCKS", as: "alice" } });
      let caught;
      try {
        await addEdge({ statePath: dir, positional: ["T-a", "T-b"], flags: { type: "BLOCKS", as: "alice" } });
      } catch (e) { caught = e; }
      assert.ok(caught, "second add-edge should throw");
      assert.equal(caught.code, "DUPLICATE_EDGE");
      assert.deepEqual(caught.details, { from: "T-a", to: "T-b", type: "BLOCKS" });
    } finally { await rmTempProject(dir); }
  });

  test("add-edge: BLOCKS A→B and BLOCKS B→A are distinct (no false dedupe)", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await addTaskNode(dir, "T-b");
      const { default: addEdge } = await importFresh("./commands/add-edge.mjs");
      await addEdge({ statePath: dir, positional: ["T-a", "T-b"], flags: { type: "BLOCKS", as: "alice" } });
      await addEdge({ statePath: dir, positional: ["T-b", "T-a"], flags: { type: "BLOCKS", as: "alice" } });
      const s = await readRawState(dir);
      assert.equal(s.edges.length, 2);
    } finally { await rmTempProject(dir); }
  });

  test("add-initiative: same name twice on v2 throws ID_CONFLICT with structured details", async () => {
    const dir = await createTempProject();
    try {
      await freshV2(dir);
      const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
      await addInit({ statePath: dir, flags: { desc: "first" }, positional: ["auth"] });
      let caught;
      try {
        await addInit({ statePath: dir, flags: { desc: "second" }, positional: ["auth"] });
      } catch (e) { caught = e; }
      assert.ok(caught, "second add-initiative should throw");
      assert.equal(caught.code, "ID_CONFLICT");
      assert.equal(caught.details.name, "auth");
      assert.ok(caught.details.existing, "details.existing should be present");
      assert.equal(caught.details.existing.desc, "first");
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class G — revision control gaps
//
// --if-revision must throw REVISION_CONFLICT when the stored revision
// has moved past the caller's expected one. Without --if-revision, last-
// write-wins is the contract. take increments revision; subsequent
// updates see the bumped revision.
// =====================================================================

describe("revision control", () => {
  test("update --if-revision matches -> applies and bumps", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const { default: update } = await importFresh("./commands/v2-update.mjs");
      const out = await update({
        statePath: dir, positional: ["T-a"],
        flags: { title: "v2", "if-revision": "1", as: "alice" },
      });
      assert.equal(out.node.revision, 2);
    } finally { await rmTempProject(dir); }
  });

  test("update --if-revision stale -> REVISION_CONFLICT, no write", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const { default: update } = await importFresh("./commands/v2-update.mjs");
      await update({
        statePath: dir, positional: ["T-a"],
        flags: { title: "first", as: "alice" },
      });
      // Now revision is 2. Caller expected 1.
      let caught;
      try {
        await update({
          statePath: dir, positional: ["T-a"],
          flags: { title: "second", "if-revision": "1", as: "bob" },
        });
      } catch (e) { caught = e; }
      assert.ok(caught, "stale CAS should throw");
      assert.equal(caught.code, "REVISION_CONFLICT");
      assert.equal(caught.details.expected, 1);
      assert.equal(caught.details.current, 2);
      const s = await readRawState(dir);
      assert.equal(s.nodes["T-a"].title, "first", "stale write must NOT have applied");
      assert.equal(s.nodes["T-a"].revision, 2);
    } finally { await rmTempProject(dir); }
  });

  test("take bumps revision; update without --if-revision observes the bumped value", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await takeNode(dir, "T-a", "alice"); // 1 → 2
      const { default: update } = await importFresh("./commands/v2-update.mjs");
      // Without --if-revision, apply.
      const out = await update({
        statePath: dir, positional: ["T-a"],
        flags: { title: "after take", as: "alice" },
      });
      assert.equal(out.node.revision, 3);
      // With --if-revision=1 (stale), reject.
      let caught;
      try {
        await update({
          statePath: dir, positional: ["T-a"],
          flags: { title: "stale", "if-revision": "1", as: "alice" },
        });
      } catch (e) { caught = e; }
      assert.equal(caught.code, "REVISION_CONFLICT");
    } finally { await rmTempProject(dir); }
  });

  test("update --if-revision=0 is rejected as not a positive integer", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const { default: update } = await importFresh("./commands/v2-update.mjs");
      let caught;
      try {
        await update({
          statePath: dir, positional: ["T-a"],
          flags: { title: "x", "if-revision": "0", as: "alice" },
        });
      } catch (e) { caught = e; }
      assert.ok(caught, "--if-revision 0 should be rejected");
      assert.match(caught.message, /positive integer/);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class H — context envelope for non-task node types
//
// The `context` view is the agent's primary read. Its envelope must be
// shaped consistently for every node type (task / gate / knowledge), and
// `allowed_actions` must surface the actual command the agent needs to
// run — including the flag shape for gates (resolve needs --choice AND
// --rationale; the agent can't tell that from "resolve" alone).
// =====================================================================

describe("context envelope per node kind", () => {
  test("context for a gate: allowed_actions for resolve hints at --choice and --rationale", async () => {
    const dir = await v2Project();
    try {
      await addGateNode(dir, "G-a");
      const { default: context } = await importFresh("./commands/context.mjs");
      const out = await context({ statePath: dir, positional: ["G-a"], flags: { as: "alice" } });
      const resolve = out.allowed_actions.find((a) => a === "resolve" || a.startsWith("resolve "));
      assert.ok(resolve, "resolve should be in allowed_actions");
      // The action hint should mention both --choice and --rationale so the
      // agent doesn't have to read source to learn what flags are required.
      assert.match(resolve, /--choice/, `resolve action must hint --choice; got: ${resolve}`);
      assert.match(resolve, /--rationale/, `resolve action must hint --rationale; got: ${resolve}`);
    } finally { await rmTempProject(dir); }
  });

  test("context for a knowledge node: returns claim=null, blocking=[], status reflects active", async () => {
    const dir = await v2Project();
    try {
      await addKnowledgeNode(dir, "K-a", { body: "x", "scope-domains": "auth" });
      const { default: context } = await importFresh("./commands/context.mjs");
      const out = await context({ statePath: dir, positional: ["K-a"], flags: {} });
      assert.equal(out.claim, null);
      assert.deepEqual(out.blocking, []);
      assert.equal(out.derived_status, "active");
      // Knowledge can be deprecated via the `deprecate-knowledge` command.
      assert.ok(out.allowed_actions.includes("deprecate-knowledge"),
        `expected deprecate-knowledge in allowed_actions; got ${JSON.stringify(out.allowed_actions)}`);
    } finally { await rmTempProject(dir); }
  });

  test("context alerts include SUPERSEDED_BLOCKER when a blocker is superseded", async () => {
    const dir = await v2Project();
    try {
      await addGateNode(dir, "G-old");
      // Create G-new with --supersedes G-old so the target is marked superseded.
      const { default: addNode } = await importFresh("./commands/add-node.mjs");
      await addNode({
        statePath: dir, positional: ["G-new"],
        flags: {
          kind: "resolvable", subkind: "gate", title: "G-new",
          initiative: "auth", purpose: "decision",
          supersedes: "G-old", as: "alice",
        },
      });
      await addTaskNode(dir, "T-x", { "blocked-by": "G-old" });
      const { default: context } = await importFresh("./commands/context.mjs");
      const out = await context({ statePath: dir, positional: ["T-x"], flags: {} });
      const superseded = out.alerts.find((a) => a.kind === "SUPERSEDED_BLOCKER");
      assert.ok(superseded, `expected SUPERSEDED_BLOCKER alert; got ${JSON.stringify(out.alerts)}`);
      assert.equal(superseded.blocker_id, "G-old");
      assert.equal(superseded.superseded_by, "G-new");
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class I — agent precedence (CLIMIER_AGENT vs --as)
// =====================================================================

describe("agent source precedence", () => {
  test("--as wins over CLIMIER_AGENT", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const prev = process.env.CLIMIER_AGENT;
      process.env.CLIMIER_AGENT = "env-agent";
      try {
        const r = await runCli(["--project", dir, "take", "T-a", "--as", "flag-agent"]);
        assert.equal(r.code, 0, r.stderr);
        const s = await readRawState(dir);
        assert.equal(s.nodes["T-a"].claim.by, "flag-agent");
      } finally {
        if (prev === undefined) delete process.env.CLIMIER_AGENT;
        else process.env.CLIMIER_AGENT = prev;
      }
    } finally { await rmTempProject(dir); }
  });

  test("CLIMIER_AGENT used when --as is absent", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const prev = process.env.CLIMIER_AGENT;
      process.env.CLIMIER_AGENT = "env-agent";
      try {
        const r = await runCli(["--project", dir, "take", "T-a"]);
        assert.equal(r.code, 0, r.stderr);
        const s = await readRawState(dir);
        assert.equal(s.nodes["T-a"].claim.by, "env-agent");
      } finally {
        if (prev === undefined) delete process.env.CLIMIER_AGENT;
        else process.env.CLIMIER_AGENT = prev;
      }
    } finally { await rmTempProject(dir); }
  });

  test("neither CLIMIER_AGENT nor --as: MISSING_AGENT with code", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const prev = process.env.CLIMIER_AGENT;
      delete process.env.CLIMIER_AGENT;
      try {
        const r = await runCli(["--project", dir, "take", "T-a"]);
        assert.equal(r.code, 1, `expected exit 1; got ${r.code}: ${r.stdout} ${r.stderr}`);
        const err = JSON.parse(r.stdout);
        assert.equal(err.error.code, "MISSING_AGENT");
        assert.equal(err.error.details.command, "take");
      } finally {
        if (prev === undefined) delete process.env.CLIMIER_AGENT;
        else process.env.CLIMIER_AGENT = prev;
      }
    } finally { await rmTempProject(dir); }
  });

  test("--as '' (empty string) falls through to CLIMIER_AGENT", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const prev = process.env.CLIMIER_AGENT;
      process.env.CLIMIER_AGENT = "env-agent";
      try {
        const r = await runCli(["--project", dir, "take", "T-a", "--as", ""]);
        assert.equal(r.code, 0, r.stderr);
        const s = await readRawState(dir);
        assert.equal(s.nodes["T-a"].claim.by, "env-agent");
      } finally {
        if (prev === undefined) delete process.env.CLIMIER_AGENT;
        else process.env.CLIMIER_AGENT = prev;
      }
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class J — init --v2 --force on existing state
//
// init --v2 must require --force when a valid state file exists. --force
// wipes the existing state. This pins the bootstrap path so a careless
// re-init doesn't silently keep v1 data while claiming v2.
// =====================================================================

describe("init --v2 --force", () => {
  test("init --v2 on an existing v1 state without --force refuses", async () => {
    const dir = await createTempProject();
    try {
      // Bootstrap a v1 state.
      const r1 = await runCli(["--project", dir, "init"]);
      assert.equal(r1.code, 0, r1.stderr);
      // Try to init --v2 without --force.
      const r2 = await runCli(["--project", dir, "init", "--v2"]);
      assert.equal(r2.code, 1, `expected exit 1; got ${r2.code}: ${r2.stdout}`);
      assert.match(JSON.parse(r2.stdout).error, /use --force to overwrite|already exists/i);
      // File is still v1.
      const s = await readRawState(dir);
      assert.equal(s.version, 1);
    } finally { await rmTempProject(dir); }
  });

  test("init --v2 --force on an existing v1 state overwrites to empty v2", async () => {
    const dir = await createTempProject();
    try {
      const r1 = await runCli(["--project", dir, "init"]);
      assert.equal(r1.code, 0, r1.stderr);
      const r2 = await runCli(["--project", dir, "init", "--v2", "--force"]);
      assert.equal(r2.code, 0, r2.stderr);
      const s = await readRawState(dir);
      assert.equal(s.version, 2);
      assert.deepEqual(s.nodes, {});
      assert.deepEqual(s.edges, []);
    } finally { await rmTempProject(dir); }
  });

  test("init --v2 --force on an existing v2 state overwrites (data loss, but explicit)", async () => {
    const dir = await createTempProject();
    try {
      let r = await runCli(["--project", dir, "init", "--v2"]);
      assert.equal(r.code, 0, r.stderr);
      r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "x"]);
      assert.equal(r.code, 0, r.stderr);
      r = await runCli(["--project", dir, "add-node", "T-a", "--kind", "resolvable", "--subkind", "task", "--title", "x", "--initiative", "auth"]);
      assert.equal(r.code, 0, r.stderr);
      r = await runCli(["--project", dir, "init", "--v2", "--force"]);
      assert.equal(r.code, 0, r.stderr);
      const s = await readRawState(dir);
      assert.equal(s.version, 2);
      assert.deepEqual(s.nodes, {}, "data must be wiped after --force reinit");
      assert.deepEqual(s.initiatives, {}, "initiatives must be wiped too");
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class K — take idempotency + takeover paths
//
// take from the same agent twice returns the same task with
// freshly_claimed=false and NO new log entry. Orchestrator can take over
// an in_progress claim. A different agent cannot.
// =====================================================================

describe("take idempotency and takeover", () => {
  test("take twice as the same agent: no second log entry, no second revision bump", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const r1 = await takeNode(dir, "T-a", "alice");
      assert.equal(r1.freshly_claimed, true);
      const r2 = await takeNode(dir, "T-a", "alice");
      assert.equal(r2.freshly_claimed, false);
      const s = await readRawState(dir);
      // Exactly one take log entry; revision is 2 (1 + 1 take).
      const takes = s.log.filter((e) => e.action === "take");
      assert.equal(takes.length, 1, `expected 1 take entry; got ${takes.length}`);
      assert.equal(s.nodes["T-a"].revision, 2);
    } finally { await rmTempProject(dir); }
  });

  test("take as orchestrator takes over alice's in_progress claim", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await takeNode(dir, "T-a", "alice");
      const { default: take } = await importFresh("./commands/take.mjs");
      const out = await take({ statePath: dir, flags: { as: "orchestrator" }, positional: ["T-a"], projectDir: dir });
      assert.equal(out.freshly_claimed, true);
      const s = await readRawState(dir);
      assert.equal(s.nodes["T-a"].claim.by, "orchestrator");
      // Log entry records previous_owner.
      const lastTake = s.log.filter((e) => e.action === "take").slice(-1)[0];
      assert.equal(lastTake.previous_owner, "alice");
    } finally { await rmTempProject(dir); }
  });

  test("take as bob on alice's claim: ALREADY_CLAIMED, not a takeover", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await takeNode(dir, "T-a", "alice");
      let caught;
      try {
        await takeNode(dir, "T-a", "bob");
      } catch (e) { caught = e; }
      assert.ok(caught);
      assert.equal(caught.code, "ALREADY_CLAIMED");
      assert.equal(caught.details.owner, "alice");
    } finally { await rmTempProject(dir); }
  });

  test("take on a `done` task: NOT_READY (cannot revive from done)", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await takeNode(dir, "T-a", "alice");
      await resolveTask(dir, "T-a", "alice", "done");
      let caught;
      try {
        await takeNode(dir, "T-a", "alice");
      } catch (e) { caught = e; }
      assert.ok(caught);
      assert.equal(caught.code, "NOT_READY");
      assert.equal(caught.details.status, "done");
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class L — resolve newly_ready diff is correct
//
// Resolving a gate that blocks exactly one task should make that task
// newly ready. Resolving a task that has downstream dependents should
// unblock them. The diff should be the symmetric difference between
// pre- and post-resolve `ready` sets.
// =====================================================================

describe("resolve: newly_ready is the diff of pre/post derive", () => {
  test("resolve a gate that unblocks one task: newly_ready contains exactly that task", async () => {
    const dir = await v2Project();
    try {
      await addGateNode(dir, "G-a");
      await addTaskNode(dir, "T-x", { "blocked-by": "G-a" });
      const { default: resolve } = await importFresh("./commands/v2-resolve.mjs");
      const out = await resolve({
        statePath: dir, flags: { as: "alice", choice: "yes", rationale: "ok" },
        positional: ["G-a"],
      });
      assert.deepEqual(out.newly_ready, ["T-x"]);
    } finally { await rmTempProject(dir); }
  });

  test("resolve a gate that unblocks nothing: newly_ready is []", async () => {
    const dir = await v2Project();
    try {
      await addGateNode(dir, "G-a");
      const { default: resolve } = await importFresh("./commands/v2-resolve.mjs");
      const out = await resolve({
        statePath: dir, flags: { as: "alice", choice: "yes", rationale: "ok" },
        positional: ["G-a"],
      });
      assert.deepEqual(out.newly_ready, []);
    } finally { await rmTempProject(dir); }
  });

  test("resolve a task with one downstream task: newly_ready contains the downstream", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      await addTaskNode(dir, "T-b", { "blocked-by": "T-a" });
      await takeNode(dir, "T-a", "alice");
      const out = await resolveTask(dir, "T-a", "alice", "done");
      assert.deepEqual(out.newly_ready, ["T-b"]);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class M — knowledge node scoping
//
// knowledgeForNode matches a knowledge node when its scope mentions the
// target via any of: node_id, domain, tag, initiative. The match should
// include the knowledge even when the knowledge is mid-supersede (it has
// status="superseded" but scope_matches still resolves).
// =====================================================================

describe("knowledge scoping on context", () => {
  test("knowledge with scope.domains matches a task whose domain is in the list", async () => {
    const dir = await v2Project();
    try {
      await addKnowledgeNode(dir, "K-auth-ttl", { body: "x", domain: "auth", "scope-domains": "auth" });
      await addTaskNode(dir, "T-a", { domain: "auth" });
      const { default: context } = await importFresh("./commands/context.mjs");
      const out = await context({ statePath: dir, positional: ["T-a"], flags: {} });
      assert.equal(out.knowledge.length, 1);
      assert.equal(out.knowledge[0].id, "K-auth-ttl");
      assert.deepEqual(out.knowledge[0].scope_matches, ["domain"]);
    } finally { await rmTempProject(dir); }
  });

  test("knowledge with scope.initiatives matches a task in that initiative", async () => {
    const dir = await v2Project();
    try {
      await addKnowledgeNode(dir, "K-sso", { body: "x", "scope-initiatives": "auth" });
      await addTaskNode(dir, "T-a");
      const { default: context } = await importFresh("./commands/context.mjs");
      const out = await context({ statePath: dir, positional: ["T-a"], flags: {} });
      assert.equal(out.knowledge.length, 1);
      assert.deepEqual(out.knowledge[0].scope_matches, ["initiative"]);
    } finally { await rmTempProject(dir); }
  });

  test("knowledge with no matching scope does NOT appear in context.knowledge", async () => {
    const dir = await v2Project();
    try {
      await addKnowledgeNode(dir, "K-orph", { body: "x", domain: "unrelated", "scope-domains": "unrelated" });
      await addTaskNode(dir, "T-a", { domain: "auth" });
      const { default: context } = await importFresh("./commands/context.mjs");
      const out = await context({ statePath: dir, positional: ["T-a"], flags: {} });
      assert.equal(out.knowledge.length, 0);
    } finally { await rmTempProject(dir); }
  });
});

// =====================================================================
// Class N — show / add-initiative / log envelopes
//
// These pin the documented shapes so a future refactor that drifts them
// is caught.
// =====================================================================

describe("envelope shape consistency", () => {
  test("show on a v2 task returns { type: 'task', node }", async () => {
    const dir = await v2Project();
    try {
      await addTaskNode(dir, "T-a");
      const { default: show } = await importFresh("./commands/show.mjs");
      const out = await show({ statePath: dir, positional: ["T-a"] });
      assert.equal(out.type, "task");
      assert.equal(out.node.id, "T-a");
      assert.equal(out.node.kind, "resolvable");
      assert.equal(out.node.subkind, "task");
    } finally { await rmTempProject(dir); }
  });

  test("show on a v2 knowledge returns { type: 'knowledge', node }", async () => {
    const dir = await v2Project();
    try {
      await addKnowledgeNode(dir, "K-a", { body: "x", "scope-domains": "auth" });
      const { default: show } = await importFresh("./commands/show.mjs");
      const out = await show({ statePath: dir, positional: ["K-a"] });
      assert.equal(out.type, "knowledge");
      assert.equal(out.node.id, "K-a");
      assert.equal(out.node.kind, "knowledge");
    } finally { await rmTempProject(dir); }
  });

  test("show on a v2 gate returns { type: 'gate', node }", async () => {
    const dir = await v2Project();
    try {
      await addGateNode(dir, "G-a");
      const { default: show } = await importFresh("./commands/show.mjs");
      const out = await show({ statePath: dir, positional: ["G-a"] });
      assert.equal(out.type, "gate");
      assert.equal(out.node.id, "G-a");
      assert.equal(out.node.subkind, "gate");
    } finally { await rmTempProject(dir); }
  });

  test("initiatives --all: includes initiatives with zero usage", async () => {
    const dir = await v2Project();
    try {
      // Add an extra initiative with no usage.
      const { default: addInit } = await importFresh("./commands/add-initiative.mjs");
      await addInit({ statePath: dir, flags: { desc: "unused" }, positional: ["unused"] });
      // Without --all, 'unused' is hidden (zero nodes).
      const { default: initiatives } = await importFresh("./commands/initiatives.mjs");
      const def = await initiatives({ statePath: dir, flags: {} });
      assert.ok(!def.initiatives.some((i) => i.name === "unused"),
        `--all=false should hide zero-usage initiative; got ${JSON.stringify(def.initiatives.map((i) => i.name))}`);
      // With --all, 'unused' shows.
      const all = await initiatives({ statePath: dir, flags: { all: true } });
      assert.ok(all.initiatives.some((i) => i.name === "unused"));
      assert.equal(all.all, true);
    } finally { await rmTempProject(dir); }
  });
});
