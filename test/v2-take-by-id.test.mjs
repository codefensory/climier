// `take <id>` claims exactly the requested v2 task.
// Filters are accepted but ignored; backlog tasks remain unclaimable.
// Orchestrator may take over another agent's claim and the log retains the old owner.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  runCli,
  writeState,
  readState,
} from "./helpers.mjs";

async function v2Project() {
  const { default: init } = await importFresh("./commands/init.mjs");
  const { default: addInitiative } = await importFresh("./commands/add-initiative.mjs");
  const dir = await createTempProject();
  await init({ statePath: dir, flags: { v2: true }, positional: [], projectDir: dir });
  await addInitiative({ statePath: dir, flags: { desc: "Auth" }, positional: ["auth"] });
  return dir;
}

async function addTask(dir, id, extra = {}) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: id,
      initiative: "auth",
      as: "setup",
      ...extra,
    },
  });
}

async function addKnowledge(dir, id) {
  const { default: addNode } = await importFresh("./commands/add-node.mjs");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "knowledge",
      title: id,
      initiative: "auth",
      as: "setup",
    },
  });
}

async function take(dir, id, flags = { as: "agent-a" }, extraPositional = []) {
  const { default: takeCommand } = await importFresh("./commands/take.mjs");
  return takeCommand({
    statePath: dir,
    projectDir: dir,
    flags,
    positional: id === undefined ? extraPositional : [id, ...extraPositional],
  });
}

async function patchNode(dir, id, patch) {
  const state = await readState(dir);
  Object.assign(state.nodes[id], patch);
  await writeState(dir, state);
}

test("take by id: claims the requested ready task and returns the v2 envelope", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    const out = await take(dir, "T-auth-1", { as: "agent-a" });

    assert.deepEqual(Object.keys(out).sort(), ["context", "freshly_claimed", "node"]);
    assert.equal(out.node.id, "T-auth-1");
    assert.equal(out.node.claim.by, "agent-a");
    assert.equal(out.node.status, "in_progress");
    assert.equal(out.context.derived_status, "in_progress");
    assert.equal(out.freshly_claimed, true);
  } finally { await rmTempProject(dir); }
});

test("take by id: repeated take by the owner is idempotent", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-auth-1");
    const first = await take(dir, "T-auth-1", { as: "agent-a" });
    const second = await take(dir, "T-auth-1", { as: "agent-a" });

    assert.deepEqual(second.node, first.node);
    assert.equal(second.freshly_claimed, false);
    assert.equal(second.context.revision, first.context.revision);
    const state = await readState(dir);
    assert.equal(state.log.filter((entry) => entry.action === "take").length, 1);
  } finally { await rmTempProject(dir); }
});

test("take by id: rejects a task claimed by another agent with ALREADY_CLAIMED", async () => {
  const dir = await v2Project();
  try {
    const { V2_ERROR_CODES } = await importFresh("./errors.mjs");
    assert.equal(V2_ERROR_CODES.ALREADY_CLAIMED, "ALREADY_CLAIMED");
    await addTask(dir, "T-auth-1");
    await patchNode(dir, "T-auth-1", {
      status: "in_progress",
      claim: { by: "other-agent", at: "2026-01-01T00:00:00.000Z" },
    });

    await assert.rejects(
      take(dir, "T-auth-1", { as: "agent-a" }),
      (err) => err.code === "ALREADY_CLAIMED" && err.details.owner === "other-agent",
    );
  } finally { await rmTempProject(dir); }
});

test("take by id: rejects an unknown id with NODE_NOT_FOUND", async () => {
  const dir = await v2Project();
  try {
    await assert.rejects(
      take(dir, "T-missing", { as: "agent-a" }),
      (err) => err.code === "NODE_NOT_FOUND" && err.details.id === "T-missing",
    );
  } finally { await rmTempProject(dir); }
});

test("take by id: rejects a knowledge node with NOT_CLAIMABLE", async () => {
  const dir = await v2Project();
  try {
    const { V2_ERROR_CODES } = await importFresh("./errors.mjs");
    assert.equal(V2_ERROR_CODES.NOT_CLAIMABLE, "NOT_CLAIMABLE");
    await addKnowledge(dir, "K-auth-ttl");

    await assert.rejects(
      take(dir, "K-auth-ttl", { as: "agent-a" }),
      (err) => err.code === "NOT_CLAIMABLE" && err.details.id === "K-auth-ttl",
    );
  } finally { await rmTempProject(dir); }
});

test("take by id: rejects done, canceled, resolved, and superseded tasks with NOT_READY", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-ready");
    for (const status of ["done", "canceled", "resolved", "superseded"]) {
      const id = `T-${status}`;
      await addTask(dir, id, { status });
      await assert.rejects(
        take(dir, id, { as: "agent-a" }),
        (err) => err.code === "NOT_READY" && err.details.status === status,
        status,
      );
    }
  } finally { await rmTempProject(dir); }
});

test("take by id: rejects a blocked task with NOT_READY", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-blocker");
    await addTask(dir, "T-x", { "blocked-by": "T-blocker" });

    await assert.rejects(
      take(dir, "T-x", { as: "agent-a" }),
      (err) => err.code === "NOT_READY" && err.details.status === "blocked",
    );
  } finally { await rmTempProject(dir); }
});

test("take by id: backlog tasks remain NOT_READY", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-ready");
    await addTask(dir, "T-x", { backlog: "true" });

    await assert.rejects(
      take(dir, "T-x", { as: "agent-a" }),
      (err) => err.code === "NOT_READY" && err.details.status === "backlog",
    );
  } finally { await rmTempProject(dir); }
});

test("take by id: orchestrator takes over another agent's in-progress task", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-x");
    await patchNode(dir, "T-x", {
      status: "in_progress",
      claim: { by: "other-agent", at: "2026-01-01T00:00:00.000Z" },
    });

    const out = await take(dir, "T-x", { as: "orchestrator" });
    assert.equal(out.node.claim.by, "orchestrator");
    assert.equal(out.node.status, "in_progress");
    assert.equal(out.freshly_claimed, true);
    const state = await readState(dir);
    const entry = state.log.at(-1);
    assert.equal(entry.action, "take");
    assert.equal(entry.agent, "orchestrator");
    assert.equal(entry.previous_owner, "other-agent");
  } finally { await rmTempProject(dir); }
});

test("CLI: take T-x --as agent-x works end to end", async () => {
  const dir = await createTempProject();
  try {
    let result = await runCli(["--project", dir, "init", "--v2"]);
    assert.equal(result.code, 0, result.stdout);
    result = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "Auth"]);
    assert.equal(result.code, 0, result.stdout);
    result = await runCli([
      "--project", dir, "add-node", "T-x",
      "--kind", "resolvable", "--subkind", "task",
      "--title", "Task X", "--initiative", "auth", "--as", "setup",
    ]);
    assert.equal(result.code, 0, result.stdout);

    result = await runCli(["--project", dir, "take", "T-x", "--as", "agent-x"]);
    assert.equal(result.code, 0, result.stdout);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["context", "freshly_claimed", "node"]);
    assert.equal(out.node.id, "T-x");
    assert.equal(out.node.claim.by, "agent-x");
    assert.equal(out.freshly_claimed, true);
  } finally { await rmTempProject(dir); }
});

test("take by id: legacy filters are accepted and ignored", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-x", { domain: "auth", tags: "backend" });
    const out = await take(dir, "T-x", {
      as: "agent-a",
      initiative: "not-auth",
      domain: "not-auth",
      tag: "frontend",
    });

    assert.equal(out.node.id, "T-x");
    assert.equal(out.freshly_claimed, true);
  } finally { await rmTempProject(dir); }
});

test("take by id: missing id throws MISSING_FIELD", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-x");
    await assert.rejects(
      take(dir, undefined, { as: "agent-a" }),
      (err) => err.code === "MISSING_FIELD" && assert.deepEqual(err.details, { field: "id" }) === undefined,
    );
  } finally { await rmTempProject(dir); }
});

test("take by id: only the first positional argument is used", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-extra");
    await addTask(dir, "T-x");
    const out = await take(dir, "T-x", { as: "agent-a" }, ["T-extra"]);

    assert.equal(out.node.id, "T-x");
    const state = await readState(dir);
    assert.equal(state.nodes["T-extra"].status, "open");
  } finally { await rmTempProject(dir); }
});

test("take by id: increments the requested node revision", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-x");
    const before = await readState(dir);
    const out = await take(dir, "T-x", { as: "agent-a" });
    const after = await readState(dir);

    assert.equal(out.node.revision, before.nodes["T-x"].revision + 1);
    assert.equal(after.nodes["T-x"].revision, out.node.revision);
  } finally { await rmTempProject(dir); }
});

test("take by id: appends a take log entry, never a claim entry", async () => {
  const dir = await v2Project();
  try {
    await addTask(dir, "T-x");
    await take(dir, "T-x", { as: "agent-a" });
    const state = await readState(dir);
    const entry = state.log.at(-1);

    assert.equal(entry.action, "take");
    assert.equal(entry.agent, "agent-a");
    assert.equal(entry.node, "T-x");
    assert.equal(state.log.some((item) => item.action === "claim"), false);
  } finally { await rmTempProject(dir); }
});
