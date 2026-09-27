// plugin-compat.test.mjs — core mutator preservation contracts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
  writeCanonicalState,
  bootstrapState,
  seedPluginData,
  assertPluginDataPreserved,
  submitAcceptTask,
  installPolicyFixture,
  uninstallPolicyFixture,
} from "./plugin-compat-helpers.mjs";

test("add-task preserves root plugins and existing per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: addTask } = await importFresh("./cli/commands/add-task.mjs");
    await addTask({
      statePath: dir,
      projectDir: dir,
      positional: ["T3"],
      flags: {
        initiative: "p",
        title: "T3",
        body: "b",
        acceptance: "a",
        "blocked-by": "",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    // New node T3 has no plugins (it was just created).
    assert.equal(after.nodes.T3.plugins, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-gate preserves root plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: addGate } = await importFresh("./cli/commands/add-gate.mjs");
    await addGate({
      statePath: dir,
      projectDir: dir,
      positional: ["G1"],
      flags: {
        initiative: "p",
        title: "G1",
        body: "b",
        purpose: "decision",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("add-knowledge preserves root plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: addKnowledge } = await importFresh("./cli/commands/add-knowledge.mjs");
    await addKnowledge({
      statePath: dir,
      projectDir: dir,
      positional: ["K1"],
      flags: {
        initiative: "p",
        title: "K1",
        body: "b",
        "scope-tags": "audit",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("update preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: update } = await importFresh("./cli/commands/update.mjs");
    await update({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: {
        title: "T1 (updated)",
        as: "tester",
      },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.title, "T1 (updated)");
  } finally {
    await rmTempProject(dir);
  }
});

test("take preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "in_progress");
    assert.equal(after.nodes.T1.claim.by, "tester");
  } finally {
    await rmTempProject(dir);
  }
});

test("submit + accept (task) preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    await submitAcceptTask(dir);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "done");
    assert.equal(after.nodes.T1.done_by, "tester");
  } finally {
    await rmTempProject(dir);
  }
});

test("resolve (gate) preserves root plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir, (s) => {
      s.nodes.G1 = {
        id: "G1",
        kind: "resolvable",
        subkind: "gate",
        title: "G1",
        initiative: "p",
        status: "open",
        resolution_mode: "choice",
        revision: 1,
        purpose: "decision",
      };
      delete s.nodes.T1;
      delete s.nodes.T2;
    });
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: resolve } = await importFresh("./cli/commands/resolve.mjs");
    await resolve({
      statePath: dir,
      projectDir: dir,
      positional: ["G1"],
      flags: { as: "tester", choice: "yes", rationale: "because" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.G1.status, "resolved");
  } finally {
    await rmTempProject(dir);
  }
});

test("reopen preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    await submitAcceptTask(dir);
    const { default: reopen } = await importFresh("./cli/commands/reopen.mjs");
    await reopen({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester", reason: "rollback" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "open");
  } finally {
    await rmTempProject(dir);
  }
});

test("release preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { default: take } = await importFresh("./cli/commands/take.mjs");
    await take({
      positional: ["T1"],
      flags: { as: "tester" },
      projectDir: dir,
      statePath: dir,
    });
    const { default: release } = await importFresh("./cli/commands/release.mjs");
    await release({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "tester" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "open");
    assert.equal(after.nodes.T1.claim, null);
  } finally {
    await rmTempProject(dir);
  }
});

test("cancel preserves root plugins and per-node plugins", async () => {
  const dir = await createTempProject();
  await installPolicyFixture(dir);
  try {
    const base = await bootstrapState(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    // Cancel an unclaimed open task. Under ADR-009 the core lets any
    // actor cancel; the policy-fixture is kept here so the test still
    // covers the seam allow branch alongside the default core path.
    // The preservation contract is independent of the authority rule
    // and is exercised separately elsewhere.
    const { default: cancel } = await importFresh("./cli/commands/cancel.mjs");
    await cancel({
      statePath: dir,
      projectDir: dir,
      positional: ["T1"],
      flags: { as: "release-manager", reason: "abandoned" },
    });
    const after = await readState(dir);
    assertPluginDataPreserved(after);
    assert.equal(after.nodes.T1.status, "canceled");
  } finally {
    await uninstallPolicyFixture(dir);
    await rmTempProject(dir);
  }
});
