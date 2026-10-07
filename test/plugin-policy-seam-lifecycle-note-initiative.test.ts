import { test } from "node:test";
import assert from "node:assert/strict";
import { importFresh, readState, stateExists, runCli, installPolicyFixture, uninstallPolicyFixture } from "./helpers.ts";
import { baseClimierJson, cli, entriesForAction, initAndSeed, withFreshEnv, writeClimierJson } from "./plugin-policy-seam-lifecycle-helpers.ts";

test("seam-add-note: note.add with no policy installed succeeds (defaults core)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    const out = await cli([
      "--project", projectDir, "add-note", "T-auth-1",
      "context note", "--as", "alice",
    ]);
    assert.ok(Array.isArray(out.node.notes));
    assert.equal(out.node.notes.length, 1);
    assert.equal(out.node.notes[0].text, "context note");
  });
});

test("seam-add-note: policy deny short-circuits BEFORE updateState (no notes appended, no log)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no notes" } },
      });
      const before = await readState(projectDir);
      const beforeRev = before.nodes["T-auth-1"].revision;
      const result = await runCli([
        "--project", projectDir, "add-note", "T-auth-1",
        "should not appear", "--as", "alice",
      ]);
      assert.equal(result.code, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ok, false);
      assert.equal(data.error.code, "POLICY_DENIED");
      assert.equal(data.error.details.action, "note.add");
      assert.equal(data.error.details.actor, "alice");
      const after = await readState(projectDir);
      // No notes appended.
      assert.equal((after.nodes["T-auth-1"].notes || []).length, 0);
      // No state mutation: revision unchanged, claim/status intact.
      assert.equal(after.nodes["T-auth-1"].revision, beforeRev);
      // No log entry for the rejected note.
      const noteEntries = entriesForAction(after, "add-note");
      assert.equal(noteEntries.length, 0);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-note: policy allow appends the note and logs it", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      const out = await cli([
        "--project", projectDir, "add-note", "T-auth-1",
        "audit", "--as", "alice",
      ]);
      assert.equal(out.node.notes.length, 1);
      assert.equal(out.node.notes[0].text, "audit");
      const s = await readState(projectDir);
      const noteEntries = entriesForAction(s, "add-note");
      assert.equal(noteEntries.length, 1);
      assert.equal(noteEntries[0].node, "T-auth-1");
      assert.equal(noteEntries[0].agent, "alice");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-note: policy abstain falls back to defaults core (note appended)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initAndSeed({ projectDir });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "abstain" } },
      });
      const out = await cli([
        "--project", projectDir, "add-note", "T-auth-1",
        "ok", "--as", "alice",
      ]);
      assert.equal(out.node.notes.length, 1);
      assert.equal(out.node.notes[0].text, "ok");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: initiative.create with no policy installed succeeds and preserves auto-create", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // Bootstrap path: no init, no state file. add-initiative must
    // auto-create the state via updateState and register the
    // initiative. The seam receives an emptyState() snapshot so a
    // plugin that only inspects shape sees a valid input.
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
    const out = await addInit({
      statePath: projectDir,
      flags: { desc: "the big move", as: "setup" },
      positional: ["bootstrap"],
    });
    assert.equal(out.initiative.name, "bootstrap");
    assert.ok(out.initiative.created_at);
    assert.equal(await stateExists(projectDir), true, "state file must be created on success");
    const s = await readState(projectDir);
    assert.equal(s.initiatives.bootstrap.desc, "the big move");
    const initEntries = entriesForAction(s, "add-initiative");
    assert.equal(initEntries.length, 1);
    assert.equal(initEntries[0].agent, "setup");
    assert.equal(initEntries[0].node, "bootstrap");
    assert.equal(initEntries[0].plugin_id, undefined);
  });
});

test("seam-add-initiative: policy deny short-circuits BEFORE updateState (no state file, no log)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // No state, no init. install the fixture and configure deny.
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no bootstrap" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
      let caught;
      try {
        await addInit({
          statePath: projectDir,
          flags: { desc: "should not stick", as: "setup" },
          positional: ["blocked"],
        });
      } catch (e) { caught = e; }
      assert.ok(caught, "should have thrown POLICY_DENIED");
      assert.equal(caught.code, "POLICY_DENIED");
      assert.equal(caught.details.action, "initiative.create");
      assert.equal(caught.details.actor, "setup");
      // No state file created.
      assert.equal(await stateExists(projectDir), false, "deny must NOT auto-create state");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: policy allow registers the initiative and writes a log entry (no plugin_id for CLI)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
      const out = await addInit({
        statePath: projectDir,
        flags: { desc: "allowed", as: "setup" },
        positional: ["allowed"],
      });
      assert.equal(out.initiative.name, "allowed");
      const s = await readState(projectDir);
      assert.equal(s.initiatives.allowed.desc, "allowed");
      const initEntries = entriesForAction(s, "add-initiative");
      assert.equal(initEntries.length, 1);
      assert.equal(initEntries[0].node, "allowed");
      // CLI call (no pluginId) — plugin_id MUST NOT be added.
      assert.equal(initEntries[0].plugin_id, undefined);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: pluginId null (CLI path) does NOT add plugin_id to the log entry", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // No fixture → defaults core. We still want to assert that the
    // CLI path (no pluginId, pluginId=null/undefined) does NOT inject
    // plugin_id into the log entry — the seam contract from

    // plugin_id when ctx.pluginId is not a non-empty string.
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
    await addInit({
      statePath: projectDir,
      flags: { desc: "cli", as: "setup" },
      positional: ["cli"],
    });
    await addInit({
      statePath: projectDir,
      flags: { desc: "cli-explicit-null", as: "setup" },
      positional: ["cli-explicit-null"],
      pluginId: null,
    });
    const s = await readState(projectDir);
    const initEntries = entriesForAction(s, "add-initiative");
    assert.equal(initEntries.length, 2);
    for (const entry of initEntries) {
      assert.equal(entry.plugin_id, undefined, `unexpected plugin_id on log entry: ${JSON.stringify(entry)}`);
    }
  });
});

test("seam-add-initiative: policy allow with ctx.pluginId writes plugin_id to the log entry", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "allow" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
      await addInit({
        statePath: projectDir,
        flags: { desc: "audit", as: "setup" },
        positional: ["audit"],
        pluginId: "example.audit",
      });
      const s = await readState(projectDir);
      const initEntries = entriesForAction(s, "add-initiative");
      assert.equal(initEntries.length, 1);
      assert.equal(initEntries[0].plugin_id, "example.audit");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: policy abstain (allow-and-decline) registers the initiative", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "abstain" } },
      });
      const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
      const out = await addInit({
        statePath: projectDir,
        flags: { desc: "abstain", as: "setup" },
        positional: ["abstain"],
      });
      assert.equal(out.initiative.name, "abstain");
      const s = await readState(projectDir);
      assert.equal(s.initiatives.abstain.desc, "abstain");
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});

test("seam-add-initiative: deny-after-existing-state does not remove the previous initiative", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    // Bootstrap first so the state exists. Pre-write project meta
    // (with canonical project_id) BEFORE addInit so the state path
    // stays stable for the rest of the test.
    await baseClimierJson(projectDir);
    const { default: addInit } = await importFresh("./cli/commands/add-initiative.ts");
    await addInit({
      statePath: projectDir,
      flags: { desc: "first", as: "setup" },
      positional: ["first"],
    });
    await installPolicyFixture(projectDir);
    try {
      await writeClimierJson(projectDir, {
        version: 1,
        project_id: "seam-lifecycle-project",
        plugins: { "policy-fixture": { mode: "deny", reason: "no second" } },
      });
      let caught;
      try {
        await addInit({
          statePath: projectDir,
          flags: { desc: "second", as: "setup" },
          positional: ["second"],
        });
      } catch (e) { caught = e; }
      assert.ok(caught);
      assert.equal(caught.code, "POLICY_DENIED");
      // First initiative survives.
      const s = await readState(projectDir);
      assert.equal(s.initiatives.first.desc, "first");
      assert.equal(s.initiatives.second, undefined);
      // Exactly one add-initiative log entry (the first one); the
      // denied call did not log.
      const initEntries = entriesForAction(s, "add-initiative");
      assert.equal(initEntries.length, 1);
    } finally { await uninstallPolicyFixture(projectDir); }
  });
});
