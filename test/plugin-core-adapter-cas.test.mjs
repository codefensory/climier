import { test } from "node:test";
import assert from "node:assert/strict";
import * as helpers from "./plugin-core-adapter-helpers.mjs";

// 5. run — fixed actor + pluginId on the wire (end-to-end, real kernel)
// =====================================================================

test("plugin-core-adapter: task.create logs carry plugin_id and the actor matches api.runtime.agent", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      const out = await core.run({
        op: "task.create",
        input: {
          id: "T-pca-1",
          initiative: "plugin-platform",
          title: "pca task",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      assert.ok(out && out.result, "kernel result returned");
      assert.equal(out.result.id, "T-pca-1");
      assert.ok(out.log_entry, "kernel produced a log entry");
      assert.equal(out.log_entry.plugin_id, "example.audit", "log entry tagged with plugin_id");
      assert.equal(out.log_entry.agent, "alice", "log entry agent is fixed by the host");
      const after = await helpers.readState(dir);
      const tagged = after.log.filter(helpers.isAuditPluginLogEntry);
      assert.ok(tagged.length >= 1, "at least one plugin-tagged log entry persisted");
      assert.equal(tagged[tagged.length - 1].agent, "alice");
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: input.as is rejected even when the rest of the input would succeed", async () => {
  // Covered above as a pure-rejection case; here we lock the
  // "rejection happens before state mutation" guarantee: the temp
  // project remains empty of user nodes after the rejected call.
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await assert.rejects(
        core.run({
          op: "task.create",
          input: {
            id: "T-spoof",
            initiative: "plugin-platform",
            title: "spoof",
            body: "b",
            acceptance: "a",
            blocked_by: "",
            as: "mallory",
          },
        }),
        helpers.isInputAsForbidden,
      );
      const after = await helpers.readState(dir);
      assert.equal(after.nodes["T-spoof"], undefined, "spoofed node was not created");
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});

// =====================================================================
// 6. run — task.update with changes+if_revision (typed CAS)
// =====================================================================

test("plugin-core-adapter: task.update consumes { id, changes, if_revision } and bumps revision by exactly 1", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      // Seed
      const created = await core.run({
        op: "task.create",
        input: {
          id: "T-upd",
          initiative: "plugin-platform",
          title: "before",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      // Update with explicit CAS (changes+if_revision). The provider
      // enforces if_revision presence; the adapter just translates.
      const out = await core.run({
        op: "task.update",
        input: {
          id: "T-upd",
          if_revision: created.diff.created[0].node.revision,
          changes: { title: "after" },
        },
      });
      assert.equal(out.diff.updated.length, 1);
      assert.equal(out.diff.updated[0].node.title, "after");
      assert.equal(out.diff.updated[0].node.revision, created.diff.created[0].node.revision + 1);
      const after = await helpers.readState(dir);
      assert.equal(after.nodes["T-upd"].title, "after");
      assert.equal(after.nodes["T-upd"].revision, out.diff.updated[0].node.revision);
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: task.update without if_revision fails inside the provider (MISSING_FIELD) and does not mutate", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      const created = await core.run({
        op: "task.create",
        input: {
          id: "T-upd-no-cas",
          initiative: "plugin-platform",
          title: "x",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      await assert.rejects(
        core.run({
          op: "task.update",
          input: { id: "T-upd-no-cas", changes: { title: "after" } },
        }),
        // Provider-level MISSING_FIELD is wrapped by the adapter via
        // wrapCoreError → PLUGIN_CORE_ACTION_FAILED with the original
        // code preserved under details.cause.code (see
        // src/plugin-errors.mjs:normalizeCoreCause). The contract is
        // the wrapped envelope, NOT the bare MISSING_FIELD.
        helpers.isTaskUpdateMissingField,
      );
      const after = await helpers.readState(dir);
      assert.equal(after.nodes["T-upd-no-cas"].title, "x", "title unchanged");
      assert.equal(after.nodes["T-upd-no-cas"].revision, created.diff.created[0].node.revision, "failed update leaves revision unchanged");
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});

// =====================================================================
// 7. run — note.add with explicit CAS (id+text+if_revision)
// =====================================================================

test("plugin-core-adapter: note.add consumes { id, text, if_revision } and appends exactly one note", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      const created = await core.run({
        op: "task.create",
        input: {
          id: "T-note",
          initiative: "plugin-platform",
          title: "note target",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      const out = await core.run({
        op: "note.add",
        input: { id: "T-note", text: "first CAS note", if_revision: created.diff.created[0].node.revision },
      });
      assert.equal(out.result.notes_count, 1);
      const after = await helpers.readState(dir);
      const note = after.nodes["T-note"].notes.find(helpers.isFirstCasNote);
      assert.ok(note, "note persisted");
      assert.equal(note.agent, "alice", "note agent is host-fixed");
      assert.equal(after.nodes["T-note"].revision, created.diff.created[0].node.revision + 1, "node revision advances globally");
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});

test("plugin-core-adapter: note.add without if_revision fails with MISSING_FIELD before mutating", async () => {
  await helpers.withIsolatedEnv(async () => {
    const dir = await helpers.createTempProject();
    try {
      const core = await helpers.freshCore(dir, { agent: "alice", pluginId: "example.audit" });
      await core.run({
        op: "task.create",
        input: {
          id: "T-note-no-cas",
          initiative: "plugin-platform",
          title: "x",
          body: "b",
          acceptance: "a",
          blocked_by: "",
        },
      });
      await assert.rejects(
        core.run({
          op: "note.add",
          input: { id: "T-note-no-cas", text: "no CAS" },
        }),
        // Provider-level MISSING_FIELD is wrapped via PLUGIN_CORE_ACTION_FAILED;
        // see the matching task.update assertion above for the rationale.
        helpers.isNoteAddMissingField,
      );
      const after = await helpers.readState(dir);
      assert.deepEqual(after.nodes["T-note-no-cas"].notes || [], []);
    } finally {
      await helpers.rmTempProject(dir);
    }
  });
});

// =====================================================================
