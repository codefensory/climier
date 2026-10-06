import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectUiActivity,
  projectUiNode,
  projectUiSnapshot,
} from "../src/read-model/ui.ts";

const NOW = Date.parse("2026-01-02T03:04:05.000Z");

function fixture() {
  return {
    version: 1,
    revision: 7,
    initiatives: {
      alpha: { desc: "Alpha work", created_at: "2026-01-01T00:00:00.000Z" },
    },
    nodes: {
      gate: {
        id: "gate",
        kind: "resolvable",
        subkind: "gate",
        title: "Approve",
        status: "resolved",
        initiative: "alpha",
      },
      task: {
        id: "task",
        kind: "resolvable",
        subkind: "task",
        title: "Ship",
        status: "open",
        initiative: "alpha",
        domain: "api",
        refs: ["docs/ship.md"],
      },
      dependent: {
        id: "dependent",
        kind: "resolvable",
        subkind: "task",
        title: "Follow up",
        status: "open",
        initiative: "alpha",
      },
      knowledge: {
        id: "knowledge",
        kind: "knowledge",
        title: "API guidance",
        body: "Use the API safely.",
        status: "active",
        initiative: "alpha",
        scope: { domains: ["api"] },
      },
    },
    edges: [
      { from: "gate", to: "task", type: "BLOCKS" },
      { from: "task", to: "dependent", type: "BLOCKS" },
    ],
    log: [
      { ts: "2026-01-01T00:00:00.000Z", agent: "alice", action: "take", node: "task" },
      { ts: "2026-01-01T00:01:00.000Z", agent: "bob", action: "update", node: "dependent", note: "follow up" },
    ],
  };
}

test("UI snapshot projection exposes the client contract without local paths", () => {
  const result = projectUiSnapshot({
    snapshot: fixture(),
    project: { id: "project-a", name: "Alpha project" },
    now: NOW,
  });

  assert.deepEqual(result.project, {
    id: "project-a",
    name: "Alpha project",
    revision: 7,
    generated_at: "2026-01-02T03:04:05.000Z",
  });
  assert.equal(Object.hasOwn(result.project, "root"), false);
  assert.equal(Object.hasOwn(result.project, "state_file"), false);
  assert.deepEqual(result.derived, {
    ready: ["task"],
    blocked: ["dependent"],
    backlog: [],
    openGates: [],
    submitted: [],
  });
  assert.equal(result.summary.ready, 1);
  assert.equal(result.summary.active_knowledge, 1);
  assert.deepEqual(result.initiative_summary[0].by_kind, {
    tasks: { total: 2, ready: 1, in_progress: 0, submitted: 0, blocked: 1, backlog: 0, done: 0, archived: 0, canceled: 0 },
    gates: { total: 1, open: 0, resolved: 1, superseded: 0 },
    knowledge: { total: 1, active: 1, deprecated: 0 },
  });
  assert.deepEqual(result.recent_activity.map((entry) => entry.node_id), ["dependent", "task"]);
  assert.deepEqual(result.last_activity.task, {
    action: "take",
    agent: "alice",
    ts: "2026-01-01T00:00:00.000Z",
  });
});

test("UI node and activity projections preserve graph semantics and pagination", () => {
  const snapshot = fixture();
  const detail = projectUiNode({ snapshot, id: "task" });
  assert.equal(detail.node.id, "task");
  assert.deepEqual(detail.blocking.map(({ node, satisfied }) => [node.id, satisfied]), [["gate", true]]);
  assert.deepEqual(detail.dependents.map(({ node }) => node.id), ["dependent"]);
  assert.deepEqual(detail.informing, []);
  assert.deepEqual(detail.knowledge.map((node) => node.id), ["knowledge"]);
  assert.deepEqual(detail.history.map((entry) => entry.node_id), ["task"]);
  assert.deepEqual(detail.refs, [{ target: "docs/ship.md", type: "doc", source: "explicit" }]);
  assert.equal(detail.derived_status, "ready");
  assert.equal(detail.is_current, true);
  assert.equal(detail.superseded_by, null);

  const activity = projectUiActivity({
    snapshot,
    filters: { q: "follow" },
    limit: 1,
    offset: 0,
  });
  assert.equal(activity.total, 1);
  assert.equal(activity.limit, 1);
  assert.equal(activity.offset, 0);
  assert.equal(activity.entries[0].node_id, "dependent");
  assert.deepEqual(activity.facets.actions, [{ action: "update", count: 1 }]);
  assert.deepEqual(activity.facets.agents, [{ agent: "bob", count: 1 }]);
});

test("UI recent activity is capped at fifty entries", () => {
  const snapshot = fixture();
  snapshot.log = Array.from({ length: 75 }, (_, index) => ({
    ts: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    agent: "alice",
    action: "note",
    node: "task",
  }));
  const result = projectUiSnapshot({ snapshot, project: { id: "p" }, now: NOW });
  assert.equal(result.recent_activity.length, 50);
  assert.equal(result.recent_activity[0].ts, snapshot.log.at(-1).ts);
  assert.equal(result.recent_activity.at(-1).ts, snapshot.log.at(-50).ts);
});
