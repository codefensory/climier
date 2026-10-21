import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createTempProject, rmTempProject, runCli, writeCanonicalState } from "./helpers.ts";
import { projectContextView, projectInitiativesView, projectLogView, projectSearchView, projectStatusView } from "../src/read-model/index.ts";
import { logEntriesForNode } from "../src/read-model/history.ts";
import type { ReadModelSnapshot } from "../src/read-model/types.ts";

const commandFiles = ["status", "context", "history", "search", "log", "initiatives", "show"];
const commandSource = new Map<string, string>();
for (const command of commandFiles) {
  commandSource.set(command, await fs.readFile(new URL(`../src/cli/commands/${command}.ts`, import.meta.url), "utf8"));
}

function fixture() {
  return {
    version: 1,
    revision: 8,
    initiatives: { alpha: { desc: "Alpha", created_at: "2026-01-01T00:00:00.000Z" }, empty: { desc: "Empty" } },
    nodes: {
      "T-done": { id: "T-done", kind: "resolvable", subkind: "task", title: "Completed", status: "done", initiative: "alpha", revision: 2, body: "done body" },
      "T-target": { id: "T-target", kind: "resolvable", subkind: "task", title: "Needle target", status: "open", initiative: "alpha", domain: "docs", tags: ["search"], body: "target body", revision: 3 },
      "G-resolved": { id: "G-resolved", kind: "resolvable", subkind: "gate", title: "Resolved gate", status: "resolved", initiative: "alpha", revision: 1 },
      "K-match": { id: "K-match", kind: "knowledge", title: "Needle knowledge", status: "active", initiative: "alpha", domain: "docs", body: "body has needle", refs: [{ target: "refNeedle", type: "test" }], scope: { initiatives: ["alpha"], domains: [], tags: [], node_ids: [] } },
      "K-other": { id: "K-other", kind: "knowledge", title: "Other", status: "active", initiative: "beta", body: "needle outside scope", scope: { initiatives: ["beta"], domains: [], tags: [], node_ids: [] } },
      "K-unicode": { id: "K-unicode", kind: "knowledge", title: "Unicode", status: "active", initiative: "alpha", body: "Información Ñandú", scope: { initiatives: ["alpha"], domains: [], tags: [], node_ids: [] } },
    },
    edges: [
      { from: "T-done", to: "T-target", type: "BLOCKS" },
      { from: "G-resolved", to: "T-target", type: "BLOCKS" },
      { from: "T-done", to: "G-resolved", type: "DERIVED_FROM" },
    ],
    log: [
      { action: "task.accept", agent: "alice", node: "T-target", revision: 7 },
      { action: "note.add", agent: "bob", note: "mentions T-target in prose", revision: 8 },
      { action: "task.update", agent: "alice", node: "T-done", revision: 9 },
    ],
  };
}

async function invoke(projectDir: string, args: string[]) {
  const result = await runCli(["--project", projectDir, ...args]);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}`);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("local read command adapters use point queries, never the full-state reader", () => {
  for (const [command, source] of commandSource) {
    assert.doesNotMatch(source, /\breadState\s*\(|\breadSqliteState\s*\(/, `${command} must not materialize the complete state`);
  }
  assert.match(commandSource.get("status")!, /readSqliteNodeMetadata/);
  assert.match(commandSource.get("status")!, /readSqliteEdges/);
  assert.match(commandSource.get("status")!, /readSqliteCounts/);
  assert.match(commandSource.get("context")!, /readSqliteNode/);
  assert.match(commandSource.get("context")!, /readSqliteEdgesOf/);
  assert.match(commandSource.get("history")!, /readSqliteLogForNode|readSqliteLogSince/);
  assert.match(commandSource.get("search")!, /readSqliteSearchCandidates/);
  assert.match(commandSource.get("log")!, /readSqliteLogEntries/);
  assert.match(commandSource.get("initiatives")!, /readSqliteInitiatives/);
  assert.match(commandSource.get("show")!, /readSqliteNode/);
});

const commandArgs = {
  status: ["status"],
  statusAll: ["status", "--all"],
  statusKnowledge: ["status", "--all", "--kind", "knowledge"],
  context: ["context", "T-target"],
  history: ["history", "T-target"],
  search: ["search", "needle"],
  searchUnicode: ["search", "ñANDÚ"],
  searchRefs: ["search", '["refNeedle"]'],
  log: ["log"],
  logFiltered: ["log", "--action", "task.accept", "--limit", "1"],
  initiatives: ["initiatives"],
  initiativesAll: ["initiatives", "--all"],
  show: ["show", "T-target"],
} as const;

function expectedViews(snapshot: ReadModelSnapshot, now: number) {
  return {
    status: projectStatusView({ snapshot, now }),
    statusAll: projectStatusView({ snapshot, filters: { all: true }, now }),
    statusKnowledge: projectStatusView({ snapshot, filters: { all: true, kind: "knowledge" }, now }),
    context: projectContextView({ snapshot, id: "T-target", agent: undefined, now }),
    history: { id: "T-target", entries: logEntriesForNode(snapshot, "T-target") },
    search: projectSearchView({ snapshot, query: "needle" }),
    searchUnicode: projectSearchView({ snapshot, query: "ñANDÚ" }),
    searchRefs: projectSearchView({ snapshot, query: '["refNeedle"]' }),
    log: projectLogView({ snapshot }),
    logFiltered: projectLogView({ snapshot, filters: { action: "task.accept", limit: "1" } }),
    initiatives: projectInitiativesView({ snapshot }),
    initiativesAll: projectInitiativesView({ snapshot, all: true }),
    show: { type: "task", node: snapshot.nodes!["T-target"] },
  };
}

async function actualViews(projectDir: string) {
  const actual: Record<string, unknown> = {};
  for (const [name, args] of Object.entries(commandArgs)) {
    actual[name] = JSON.parse(await invoke(projectDir, [...args]));
  }
  return actual;
}

test("point-read CLI views retain the canonical read-model JSON and ordering", async () => {
  const projectDir = await createTempProject();
  try {
    const snapshot = await writeCanonicalState(projectDir, fixture()) as unknown as ReadModelSnapshot;
    const expected = expectedViews(snapshot, Date.now());
    const actual = await actualViews(projectDir);
    assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)));
    for (const [name, args] of Object.entries(commandArgs)) {
      assert.equal(await invoke(projectDir, [...args]), `${JSON.stringify(expected[name], null, 2)}\n`);
    }
  } finally {
    await rmTempProject(projectDir);
  }
});
