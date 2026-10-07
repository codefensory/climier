/* eslint-disable max-statements -- This update regression case preserves the complete field-normalization contract. */
// F6 — update: field edits, revision tracking, --if-revision optimistic concurrency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState as readRawState, runCli } from "./helpers.mjs";

async function projectFixture() {
  const { default: init } = await importFresh("./cli/commands/init.ts");
  const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
  const dir = await createTempProject();
  await init({ statePath: dir, positional: [], projectDir: dir });
  await addInit({ statePath: dir, flags: { desc: "auth" }, positional: ["auth"] });
  return dir;
}

async function seedTask(dir, id = "T-auth-1", extra = {}) {
  const { default: addNode } = await importFresh("./cli/commands/add-node.ts");
  return addNode({
    statePath: dir,
    positional: [id],
    flags: {
      kind: "resolvable",
      subkind: "task",
      title: "Implement session middleware",
      initiative: "auth",
      domain: "auth",
      tags: "backend,api",
      ...extra,
    },
  });
}

// --- revision initialization on creation ----------------------------------

test("add-node: initializes revision = 1 on a new node", async () => {
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].revision, s.revision);
  } finally { await rmTempProject(dir); }
});

// --- happy path: field edits bump the revision --------------------------

test("update: changes title and bumps revision to 2", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const before = await readRawState(dir);
    const currentRevision = before.nodes["T-auth-1"].revision;
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { title: "Implement opaque session middleware", as: "alice" },
    });
    assert.equal(out.node.title, "Implement opaque session middleware");
    assert.equal(out.node.revision, currentRevision + 1);

    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].title, "Implement opaque session middleware");
    assert.equal(s.nodes["T-auth-1"].revision, currentRevision + 1);
  } finally { await rmTempProject(dir); }
});

test("update: the typed patch reaches the node through one canonical operation and one kernel mutation", async () => {
  const { bootstrapBuiltins } = await import("../src/application/operations/builtins.ts");
  const { mutate: kernelMutate } = await import("../src/kernel/mutate.ts");
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  const operations: string[] = [];
  const mutations: Array<{ policyActionFromPlan?: boolean }> = [];
  try {
    await seedTask(dir);
    const registry = bootstrapBuiltins();
    const source = {
      registry: {
        lookup(operation) {
          operations.push(operation);
          return registry.lookup(operation);
        },
      },
      mutate(args) {
        mutations.push(args);
        return kernelMutate(args);
      },
      selectPolicy: async () => null,
    };

    const out = await update({
      statePath: dir,
      projectDir: dir,
      source,
      positional: ["T-auth-1"],
      flags: { title: "updated through bridge", meta: '{"ticket":"AUTH-bridge"}', as: "alice" },
    });

    assert.deepEqual(operations, ["task.update"], "one canonical operation is selected");
    assert.equal(mutations.length, 1, "the typed patch and the operation share one kernel mutation");
    assert.equal(mutations[0].policyActionFromPlan, true);
    assert.equal(out.node.title, "updated through bridge");
    assert.deepEqual(out.node.meta, { ticket: "AUTH-bridge" });
    const state = await readRawState(dir);
    assert.equal(state.nodes["T-auth-1"].revision, out.node.revision);
    assert.equal(state.log.at(-1).action, "update");
  } finally { await rmTempProject(dir); }
});

test("update: idempotent bridge result retains the current node revision", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const before = await readRawState(dir);
    const revision = before.nodes["T-auth-1"].revision;
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { title: before.nodes["T-auth-1"].title, as: "alice" },
    });
    assert.equal(out.node.revision, revision);
    const after = await readRawState(dir);
    assert.equal(after.nodes["T-auth-1"].revision, revision);
    assert.equal(after.log.length, before.log.length);
  } finally { await rmTempProject(dir); }
});

test("update: parses --meta JSON and persists it", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const currentRevision = (await readRawState(dir)).nodes["T-auth-1"].revision;
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { meta: '{"ticket":"AUTH-9001","severity":"high"}', as: "alice" },
    });
    assert.deepEqual(out.node.meta, { ticket: "AUTH-9001", severity: "high" });
    assert.equal(out.node.revision, currentRevision + 1);
  } finally { await rmTempProject(dir); }
});

test("update: parses --tags CSV and replaces the tag set", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { tags: "backend,api,critical", as: "alice" },
    });
    assert.deepEqual(out.node.tags, ["backend", "api", "critical"]);
  } finally { await rmTempProject(dir); }
});

test("update: bumps revision on every successful mutation", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const before = await readRawState(dir);
    const initialRevision = before.nodes["T-auth-1"].revision;
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "v2", as: "alice" } });
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "v3", as: "alice" } });
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "v4", as: "alice" } });
    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].title, "v4");
    assert.equal(s.nodes["T-auth-1"].revision, initialRevision + 3);
  } finally { await rmTempProject(dir); }
});

// --- --if-revision optimistic concurrency --------------------------------

test("update: --if-revision matching current revision applies and increments", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const currentRevision = (await readRawState(dir)).nodes["T-auth-1"].revision;
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { title: "after CAS", "if-revision": currentRevision, as: "alice" },
    });
    assert.equal(out.node.revision, currentRevision + 1);
    assert.equal(out.node.title, "after CAS");
  } finally { await rmTempProject(dir); }
});

test("update: --if-revision mismatch returns REVISION_CONFLICT with expected/current", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const originalRevision = (await readRawState(dir)).nodes["T-auth-1"].revision;
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "stale", as: "alice" } });
    const currentRevision = (await readRawState(dir)).nodes["T-auth-1"].revision;
    // Caller still holds the seed revision; should fail.
    let caught;
    try {
      await update({
        statePath: dir,
        positional: ["T-auth-1"],
        flags: { title: "too late", "if-revision": originalRevision, as: "bob" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "REVISION_CONFLICT");
    assert.equal(caught.details.expected, originalRevision);
    assert.equal(caught.details.current, currentRevision);

    const s = await readRawState(dir);
    assert.equal(s.nodes["T-auth-1"].title, "stale");
    assert.equal(s.nodes["T-auth-1"].revision, currentRevision);
  } finally { await rmTempProject(dir); }
});

test("update: without --if-revision a stale snapshot still mutates", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const initialRevision = (await readRawState(dir)).nodes["T-auth-1"].revision;
    await update({ statePath: dir, positional: ["T-auth-1"], flags: { title: "first", as: "alice" } });
    // No --if-revision -> last-write-wins, no conflict.
    const out = await update({
      statePath: dir,
      positional: ["T-auth-1"],
      flags: { title: "second", as: "bob" },
    });
    assert.equal(out.node.title, "second");
    assert.equal(out.node.revision, initialRevision + 2);
  } finally { await rmTempProject(dir); }
});

// --- error cases ---------------------------------------------------------

test("update: missing node returns NODE_NOT_FOUND", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await projectFixture();
  try {
    let caught;
    try {
      await update({ statePath: dir, positional: ["ghost"], flags: { title: "x", as: "alice" } });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "NODE_NOT_FOUND");
    assert.equal(caught.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});

test("update: rejects update on a future state with the public incompatibility code", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8"));
    const climierHome = process.env.CLIMIER_HOME;
    assert.ok(climierHome, "CLIMIER_HOME must be set by the test helpers");
    const futureFile = path.join(climierHome, "projects", meta.project_id, "tasks.json");
    await fs.writeFile(futureFile, JSON.stringify({
      version: 6,
      nodes: {}, edges: [], initiatives: {}, log: [],
    }), "utf8");
    let caught;
    try {
      await update({ statePath: dir, positional: ["T1"], flags: { title: "y", as: "alice" } });
    } catch (error) { caught = error; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "CLIMIER_INCOMPATIBLE_VERSION");
    assert.match(caught.message, /version 6/i);
  } finally { await rmTempProject(dir); }
});

test("update: rejects a pre-release state with migration guidance", async () => {
  const { default: update } = await importFresh("./cli/commands/update.ts");
  const dir = await createTempProject();
  try {
    // Bootstrap .climier.json + an empty canonical state, then overwrite the

    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, flags: {}, positional: [], projectDir: dir });
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".climier.json"), "utf8"));
    const climierHome = process.env.CLIMIER_HOME;
    assert.ok(climierHome, "CLIMIER_HOME must be set by the test helpers");
    const v1File = path.join(climierHome, "projects", meta.project_id, "tasks.json");
    await fs.writeFile(v1File, JSON.stringify({
      version: 1,
      tasks: { F0T1: { id: "F0T1", title: "v1 task", initiative: "x" } },
      decisions: {}, gotchas: {}, initiatives: { x: {} }, log: [],
    }), "utf8");
    let caught;
    try {
      await update({ statePath: dir, positional: ["F0T1"], flags: { title: "y", as: "alice" } });
    } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.equal(caught.code, "PRE_RELEASE_STATE_UNSUPPORTED");
    assert.match(caught.message, /climier migrate/i);
    assert.doesNotMatch(caught.message, /init --force/i);
  } finally { await rmTempProject(dir); }
});

// --- CLI dispatch --------------------------------------------------------

test("CLI: preserves Markdown in task fields and appended notes verbatim", async () => {
  const dir = await projectFixture();
  try {
    await seedTask(dir);
    const body = "## Goal\n\nShip the session boundary.\n\n## Constraints\n- Keep the public API stable.";
    const acceptance = "- [ ] Existing tests pass.\n- [ ] New behavior has regression coverage.";
    const note = "### Verification\n- `npm test` — passed.";
    const updated = await runCli(["--project", dir, "update", "T-auth-1", "--body", body, "--acceptance", acceptance, "--as", "alice"]);
    assert.equal(updated.code, 0, updated.stdout);
    assert.equal(JSON.parse(updated.stdout).node.body, body);
    assert.equal(JSON.parse(updated.stdout).node.acceptance, acceptance);

    const added = await runCli(["--project", dir, "add-note", "T-auth-1", note, "--as", "alice"]);
    assert.equal(added.code, 0, added.stdout);
    assert.equal(JSON.parse(added.stdout).node.notes.at(-1).text, note);
  } finally { await rmTempProject(dir); }
});

test("CLI: update emits REVISION_CONFLICT with structured details", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "test"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli([
      "--project", dir, "add-node", "T-auth-1",
      "--kind", "resolvable", "--subkind", "task", "--title", "t",
      "--initiative", "auth",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const originalRevision = JSON.parse(r.stdout).node.revision;
    r = await runCli(["--project", dir, "update", "T-auth-1", "--title", "v2", "--as", "alice"]);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    const currentRevision = data.node.revision;
    assert.ok(currentRevision > originalRevision);

    // Stale CAS.
    r = await runCli([
      "--project", dir, "update", "T-auth-1",
      "--title", "v3",
      "--if-revision", String(originalRevision),
      "--as", "bob",
    ]);
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    assert.equal(err.error.code, "REVISION_CONFLICT");
    assert.equal(err.error.details.expected, originalRevision);
    assert.equal(err.error.details.current, currentRevision);
  } finally { await rmTempProject(dir); }
});

test("CLI: update missing node emits NODE_NOT_FOUND", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(["--project", dir, "update", "ghost", "--title", "x", "--as", "alice"]);
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stdout);
    assert.equal(err.error.code, "NODE_NOT_FOUND");
    assert.equal(err.error.details.id, "ghost");
  } finally { await rmTempProject(dir); }
});
// --- typed contract per kind (ADR-038 decision 4) -------------------------

async function seedProjectWithTaskAndKnowledge(dir) {
  let r = await runCli(["--project", dir, "init"]);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "x"]);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(["--project", dir, "add-node", "T-auth-1", "--kind", "resolvable", "--subkind", "task",
    "--title", "t", "--initiative", "auth"]);
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(["--project", dir, "add-knowledge", "K-auth-1", "--initiative", "auth", "--title", "k",
    "--body", "b", "--scope-domains", "auth"]);
  assert.equal(r.code, 0, r.stderr);
}

test("CLI: a known key that does not apply to the node kind is rejected naming the allowed keys", async () => {
  const dir = await createTempProject();
  try {
    await seedProjectWithTaskAndKnowledge(dir);
    const taskKeys = ["purpose", "resolution-mode", "mitigation", "knowledge-type", "scope-domains", "scope-tags"];
    for (const flag of taskKeys) {
      const r = await runCli(["--project", dir, "update", "T-auth-1", `--${flag}`, "x", "--as", "alice"]);
      assert.equal(r.code, 1, `--${flag} on a task must be rejected: ${r.stdout}`);
      const data = JSON.parse(r.stdout);
      assert.equal(data.error.code, "INVALID_EXECUTION_CONTRACT", `--${flag}: ${r.stdout}`);
      assert.match(data.error.message, /allowed: /);
      assert.ok(data.error.details.allowed.includes("title"), `--${flag} must name the allowed task keys`);
      assert.ok(!data.error.details.allowed.includes(flag.replace(/-/g, "_")), `--${flag} must not be allowed on a task`);
    }
    const onKnowledge = await runCli(["--project", dir, "update", "K-auth-1", "--backlog", "true", "--as", "alice"]);
    assert.equal(onKnowledge.code, 1, `--backlog on a knowledge node must be rejected: ${onKnowledge.stdout}`);
    assert.match(JSON.parse(onKnowledge.stdout).error.message, /allowed: /);
  } finally {
    await rmTempProject(dir);
  }
});

test("CLI: --backlog and --meta on a task both go through the typed contract", async () => {
  const dir = await createTempProject();
  try {
    await seedProjectWithTaskAndKnowledge(dir);
    const backlog = await runCli(["--project", dir, "update", "T-auth-1", "--backlog", "true", "--as", "alice"]);
    assert.equal(backlog.code, 0, backlog.stderr);
    assert.equal(JSON.parse(backlog.stdout).node.backlog, true);

    const cleared = await runCli(["--project", dir, "update", "T-auth-1", "--backlog", "false", "--as", "alice"]);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(JSON.parse(cleared.stdout).node.backlog, false);

    const meta = await runCli(["--project", dir, "update", "T-auth-1", "--meta", '{"ticket":"AUTH-1"}', "--as", "alice"]);
    assert.equal(meta.code, 0, meta.stderr);
    assert.deepEqual(JSON.parse(meta.stdout).node.meta, { ticket: "AUTH-1" });

    const state = await readRawState(dir);
    assert.equal(state.nodes["T-auth-1"].backlog, false);
    assert.deepEqual(state.nodes["T-auth-1"].meta, { ticket: "AUTH-1" });
  } finally {
    await rmTempProject(dir);
  }
});
