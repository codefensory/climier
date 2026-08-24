// The UI server (ui/server/server.mjs) must reflect the live state file on
// every request: mutations made through the CLI (atomic tmp+rename writes)
// have to show up without restarting the server or reloading the page.
// Regression for the previous "state cached once at boot" behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { updateState } from "../src/state.mjs";
import {
  createTempProject,
  rmTempProject,
  writeState,
  readState,
  initExampleProject,
  runCli,
  exampleState,
  stateFilePath,
} from "./helpers.mjs";

const SERVER_FILE = path.resolve("ui/server/server.mjs");
const UI_DEPS_OK = fs.existsSync(path.resolve("ui/node_modules/express"));
const skip = UI_DEPS_OK ? false : "ui dependencies not installed (run npm install in ui/)";

const serverMod = await import(pathToFileURL(SERVER_FILE).href);

async function startServer(projectDir) {
  const started = await serverMod.start({ projectDir, port: 0, log: () => {} });
  const port = started.server.address().port;
  return { base: `http://127.0.0.1:${port}`, server: started.server };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `GET ${url} failed`);
  return r.json();
}

test("snapshot and node endpoints reflect state mutations without restart", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const before = await getJson(`${base}/api/snapshot`);
  assert.equal(before.project.initialized, true);
  assert.equal(before.nodes["F0.T1"].status, "open");
  const nodeBefore = await getJson(`${base}/api/node/F0.T1`);
  assert.equal(nodeBefore.node.status, "open");

  // Simulate a CLI mutation while the server is running (atomic write,
  // same path the real CLI uses: tmp file + rename).
  await updateState(dir, (s) => ({
    ...s,
    nodes: { ...s.nodes, "F0.T1": { ...s.nodes["F0.T1"], status: "done" } },
    log: [...s.log, { action: "resolve", node: "F0.T1", agent: "ui-live-test", ts: new Date().toISOString(), note: "ui live test" }],
  }));

  const after = await getJson(`${base}/api/snapshot`);
  assert.equal(after.nodes["F0.T1"].status, "done");
  assert.equal(after.summary.done, 1);
  assert.equal(after.recent_activity[0].node, "F0.T1");
  const nodeAfter = await getJson(`${base}/api/node/F0.T1`);
  assert.equal(nodeAfter.node.status, "done");
});

test("snapshot picks up a project initialized while the server runs", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  // No state file yet: the project starts uninitialized.
  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const before = await getJson(`${base}/api/snapshot`);
  assert.equal(before.project.initialized, false);

  await writeState(dir, exampleState());

  const after = await getJson(`${base}/api/snapshot`);
  assert.equal(after.project.initialized, true);
  assert.ok(after.nodes["F0.T1"]);
});

test("corrupt state mid-run serves last good snapshot with a state-read-error alert", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  // Corrupt the state file behind the running server's back.
  await fs.promises.writeFile(stateFilePath(dir), "{ not json", "utf8");

  const snap = await getJson(`${base}/api/snapshot`);
  // The UI stays alive on the last good state, with a visible alert.
  assert.equal(snap.project.initialized, true);
  assert.ok(snap.nodes["F0.T1"]);
  assert.ok(snap.alerts.some((a) => a.kind === "state-read-error"));
});

// --- Phase 1: contrato de lectura -----------------------------------------

function withClaim(state, id, claim) {
  return { ...state, nodes: { ...state.nodes, [id]: { ...state.nodes[id], claim } } };
}

test("open gate derived_status is 'open' (not 'ready')", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  // D1 is an open decision gate in the example fixture.
  const node = await getJson(`${base}/api/node/D1`);
  assert.equal(node.derived_status, "open", "an open gate must report derived_status=open");
});

test("stale-claim alert uses claim.at (not claim.ts)", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  // Stale-claim alerts only fire on in_progress tasks (per the plan: a
  // done task with an old claim is not stale work). Set the status too.
  baseState.nodes["F0.T1"].status = "in_progress";
  await writeState(dir, withClaim(baseState, "F0.T1", { by: "alice", at: staleAt }));

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  const stale = snap.alerts.find((a) => a.kind === "stale-claim");
  assert.ok(stale, "expected a stale-claim alert for an old in_progress claim");
  assert.equal(stale.severity, "warning");
  assert.equal(stale.node_id, "F0.T1");
  assert.ok(stale.message && stale.message.includes("F0.T1"));
});

test("summary includes placeholders, archived, open_decisions and counts zero when missing", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  // exampleState has multiple placeholders (F2.OPEN..F9.OPEN) and decision
  // gates (D1..D4), so placeholders > 0, open_decisions = 4.
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  assert.ok(snap.summary, "summary must exist");
  assert.ok(Number.isInteger(snap.summary.placeholders));
  // exampleState has 8 placeholders: F2-F9.OPEN
  assert.ok(snap.summary.placeholders >= 8, `placeholders should count F2-F9 (>=8), got ${snap.summary.placeholders}`);
  assert.equal(snap.summary.open_decisions, 4);
  assert.equal(snap.summary.archived, 0);
  assert.ok(Number.isInteger(snap.summary.canceled));
  assert.ok(Number.isInteger(snap.summary.superseded));
  assert.ok(Number.isInteger(snap.summary.resolved_gates));
  assert.equal(snap.summary.total_nodes, Object.keys(snap.nodes).length);
});

test("refs come back as structured objects {target,type,source}", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  // Mix: a structured ref, a bare string ref, and a body that references a doc path.
  baseState.nodes["F0.T1"].refs = [
    { target: "docs/architecture.md", type: "doc", source: "body" },
    "docs/notes.md",
  ];
  baseState.nodes["F0.T1"].body = "see docs/from-body.md for the design";
  await writeState(dir, baseState);

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const node = await getJson(`${base}/api/node/F0.T1`);
  assert.ok(Array.isArray(node.refs));
  const foundStructured = node.refs.find((r) => r.target === "docs/architecture.md" && r.source === "body");
  assert.ok(foundStructured, "explicit structured ref must round-trip");
  const foundString = node.refs.find((r) => r.target === "docs/notes.md");
  assert.ok(foundString, "bare-string ref must be normalized to a structured object");
  assert.ok(foundString.type);
  assert.ok(foundString.source);
  const foundBody = node.refs.find((r) => r.target === "docs/from-body.md");
  assert.ok(foundBody, "doc paths referenced in the body must surface as structured refs");
  for (const r of node.refs) {
    assert.equal(typeof r.target, "string");
    assert.equal(typeof r.type, "string");
    assert.equal(typeof r.source, "string");
  }
});

test("recent_activity entries expose node_id and node_title for add-node events", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  const ts = new Date().toISOString();
  baseState.log = [
    ...baseState.log,
    { action: "add-node", node: "F2.OPEN", agent: "bob", ts, note: "added placeholder" },
  ];
  await writeState(dir, baseState);

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  const last = snap.recent_activity[snap.recent_activity.length - 1];
  assert.equal(last.action, "add-node");
  assert.equal(last.node_id, "F2.OPEN");
  assert.equal(last.node_title, baseState.nodes["F2.OPEN"].title);
});

test("project_id is read from .climier.json metadata", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  // The meta file must exist BEFORE the state file so the global state
  // path resolves to the same project_id the meta advertises. Otherwise
  // writeState falls back to the default (hash-of-dir) project id and
  // the server reads from a different path than we wrote.
  await fs.promises.writeFile(
    path.join(dir, ".climier.json"),
    JSON.stringify({ version: 1, project_id: "abcdef1234567890" }),
  );
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  assert.equal(snap.project.initialized, true);
  assert.equal(snap.project.project_id, "abcdef1234567890");
});

test("initiative_summary breaks down totals by kind", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const snap = await getJson(`${base}/api/snapshot`);
  assert.ok(Array.isArray(snap.initiative_summary));
  const mig = snap.initiative_summary.find((i) => i.initiative === "migration");
  assert.ok(mig, "migration initiative must be present");
  assert.ok(mig.by_kind, "initiative_summary must include by_kind breakdown");
  // exampleState has 14 tasks (F0.T1-T4, F1.T1-T2, F2-F9.OPEN placeholders),
  // 4 gates (D1-D4), 5 knowledge (G1-G5).
  assert.ok(mig.by_kind.tasks && mig.by_kind.tasks.total >= 14, `tasks.total got ${mig.by_kind.tasks && mig.by_kind.tasks.total}`);
  assert.ok(mig.by_kind.gates && mig.by_kind.gates.total >= 4);
  assert.ok(mig.by_kind.knowledge && mig.by_kind.knowledge.total >= 5);
});

// --- Phase 5D Track D: Activity endpoint (q, initiative, facets) ---------

test("activity endpoint supports q filter (substring across note/agent/action/node)", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  baseState.log = [
    { action: "add-note", node: "F0.T1", agent: "alice", ts: new Date().toISOString(), note: "first discovery" },
    { action: "take", node: "F0.T2", agent: "bob", ts: new Date().toISOString(), note: "F0.T2" },
    { action: "resolve", node: "F0.T3", agent: "alice", ts: new Date().toISOString(), note: "shipped to staging" },
  ];
  await writeState(dir, baseState);

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  // q matches against agent
  const r1 = await getJson(`${base}/api/activity?q=alice`);
  assert.equal(r1.total, 2, "q=alice must match the two entries with agent=alice");
  for (const e of r1.entries) assert.equal(e.agent, "alice");

  // q matches against note text
  const r2 = await getJson(`${base}/api/activity?q=staging`);
  assert.equal(r2.total, 1);
  assert.equal(r2.entries[0].node_id, "F0.T3");

  // q matches against action
  const r3 = await getJson(`${base}/api/activity?q=add-note`);
  assert.equal(r3.total, 1);
  assert.equal(r3.entries[0].action, "add-note");
});

test("activity endpoint supports initiative filter (against the node's initiative)", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  // Two entries, two different initiatives.
  baseState.nodes["F0.T1"].initiative = "alpha";
  baseState.nodes["F0.T2"].initiative = "beta";
  baseState.log = [
    { action: "take", node: "F0.T1", agent: "alice", ts: new Date().toISOString(), note: "F0.T1" },
    { action: "take", node: "F0.T2", agent: "bob", ts: new Date().toISOString(), note: "F0.T2" },
  ];
  await writeState(dir, baseState);

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const r = await getJson(`${base}/api/activity?initiative=alpha`);
  assert.equal(r.total, 1);
  assert.equal(r.entries[0].node_id, "F0.T1");

  const r2 = await getJson(`${base}/api/activity?initiative=beta`);
  assert.equal(r2.total, 1);
  assert.equal(r2.entries[0].node_id, "F0.T2");
});

test("activity endpoint returns facets for actions and agents (derived from the log)", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  // Custom action that would NOT exist in a fixed list of actions.
  baseState.log = [
    { action: "take", node: "F0.T1", agent: "alice", ts: new Date().toISOString(), note: "F0.T1" },
    { action: "take", node: "F0.T2", agent: "alice", ts: new Date().toISOString(), note: "F0.T2" },
    { action: "resolve", node: "F0.T3", agent: "bob", ts: new Date().toISOString(), note: "shipped" },
    { action: "supersede", node: "F0.T4", agent: "alice", ts: new Date().toISOString(), note: "F0.T4 supersedes X" },
    // A future / custom action must still appear in facets.
    { action: "import-batch", node: "F0.T1", agent: "importer", ts: new Date().toISOString(), note: "bulk import" },
  ];
  await writeState(dir, baseState);

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const r = await getJson(`${base}/api/activity`);
  assert.ok(r.facets, "response must include facets");
  const actionByName = Object.fromEntries(r.facets.actions.map((a) => [a.action, a.count]));
  assert.equal(actionByName.take, 2);
  assert.equal(actionByName.resolve, 1);
  assert.equal(actionByName.supersede, 1);
  assert.equal(actionByName["import-batch"], 1, "custom / future actions must appear in facets");
  const agentByName = Object.fromEntries(r.facets.agents.map((a) => [a.agent, a.count]));
  assert.equal(agentByName.alice, 3);
  assert.equal(agentByName.bob, 1);
  assert.equal(agentByName.importer, 1);
});

test("activity node_title is read from the current state (not from the log entry)", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  baseState.log = [
    { action: "take", node: "F0.T1", agent: "alice", ts: new Date().toISOString(), note: "F0.T1" },
  ];
  // Rename the node AFTER the log entry was written.
  baseState.nodes["F0.T1"].title = "Renamed skeleton task";
  await writeState(dir, baseState);

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const r = await getJson(`${base}/api/activity`);
  const entry = r.entries.find((e) => e.node_id === "F0.T1");
  assert.ok(entry);
  assert.equal(entry.node_title, "Renamed skeleton task", "node_title must reflect the current title");
});

test("activity entry for an unknown node has node_id set but node_title null", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  const baseState = exampleState();
  // Log entry pointing at a node that does not exist in state.nodes.
  baseState.log = [
    { action: "take", node: "GHOST", agent: "alice", ts: new Date().toISOString(), note: "GHOST" },
  ];
  await writeState(dir, baseState);

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const r = await getJson(`${base}/api/activity`);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].node_id, "GHOST");
  assert.equal(r.entries[0].node_title, null);
});

// --- Phase 5D Track D: normalize log writes so the UI can open the detail -

test("add-node (real CLI path) writes a log entry with `node` so the UI can open the detail", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await initExampleProject(dir);

  const r = await runCli([
    "--project", dir,
    "add-node", "T-new",
    "--kind", "resolvable",
    "--subkind", "task",
    "--initiative", "migration",
    "--title", "Brand new task",
    "--as", "tester",
  ]);
  assert.equal(r.code, 0, `add-node failed: ${r.stderr}`);

  const state = await readState(dir);
  const logEntry = state.log.find((e) => e.action === "add-node" && e.note === "T-new");
  assert.ok(logEntry, "add-node must write a log entry");
  assert.equal(logEntry.node, "T-new", "log entry must carry node=T-new so the UI can navigate");

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const activity = await getJson(`${base}/api/activity?action=add-node`);
  const entry = activity.entries.find((e) => e.note === "T-new");
  assert.ok(entry);
  assert.equal(entry.node_id, "T-new");
  assert.equal(entry.node_title, "Brand new task");
});

test("add-edge (real CLI path) writes a log entry with `node` for activity linking", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await initExampleProject(dir);

  const r = await runCli([
    "--project", dir,
    "add-edge", "F0.T1", "F0.T3",
    "--type", "BLOCKS",
    "--as", "tester",
  ]);
  assert.equal(r.code, 0, `add-edge failed: ${r.stderr}`);

  const state = await readState(dir);
  const logEntry = state.log.find((e) => e.action === "add-edge" && /F0\.T1.*BLOCKS.*F0\.T3/.test(e.note));
  assert.ok(logEntry, "add-edge must write a log entry");
  assert.ok(logEntry.node, "add-edge log entry must carry a node so the activity list links to it");

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  const activity = await getJson(`${base}/api/activity?action=add-edge`);
  assert.ok(activity.entries.length >= 1, "add-edge must surface in the activity endpoint");
  for (const e of activity.entries) {
    assert.ok(e.node_id, "every add-edge entry must expose node_id");
  }
});

test("GET endpoints never mutate the live state file", { skip }, async (t) => {
  const dir = await createTempProject();
  t.after(() => rmTempProject(dir));
  await writeState(dir, exampleState());

  const { base, server } = await startServer(dir);
  t.after(() => closeServer(server));

  // Fire a handful of reads; the file mtime must not change.
  const stateFile = stateFilePath(dir);
  const before = fs.statSync(stateFile);
  await new Promise((r) => setTimeout(r, 50));
  await Promise.all([
    fetch(`${base}/api/snapshot`).then((r) => r.json()),
    fetch(`${base}/api/node/F0.T1`).then((r) => r.json()),
    fetch(`${base}/api/node/D1`).then((r) => r.json()),
    fetch(`${base}/api/activity`).then((r) => r.json()),
  ]);
  const after = fs.statSync(stateFile);
  assert.equal(after.mtimeMs, before.mtimeMs, "GET requests must not rewrite the state file");
});
