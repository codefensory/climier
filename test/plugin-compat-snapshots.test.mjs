// plugin-compat.test.mjs — snapshot and restore contracts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  importFresh,
  readState,
  seedPluginFixture,
  baseState,
  seedPluginData,
  assertPluginDataPreserved,
  snapshotDir,
  submitAcceptTask,
  writeCanonicalState,
} from "./plugin-compat-helpers.mjs";

test("createSnapshot preserves `plugins` and `nodes[id].plugins` in raw bytes", async () => {
  const dir = await createTempProject();
  try {
    const base = await seedPluginFixture(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { createSnapshot } = await importFresh("./storage/state.ts");
    const meta = await createSnapshot(dir, "force-init");
    const rawBytes = await fs.readFile(
      path.join(snapshotDir(dir), `${meta.id}.json`),
      "utf8",
    );
    const parsed = JSON.parse(rawBytes);
    assertPluginDataPreserved(parsed);
  } finally {
    await rmTempProject(dir);
  }
});

test("listSnapshots is unaffected by plugin data (metadata contract unchanged)", async () => {
  const dir = await createTempProject();
  try {
    const base = await seedPluginFixture(dir);
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { createSnapshot, listSnapshots } = await importFresh("./storage/state.ts");
    const meta = await createSnapshot(dir, "force-init");
    const snaps = await listSnapshots(dir);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].id, meta.id);
    assert.equal(snaps[0].reason, "force-init");
    assert.equal(typeof snaps[0].bytes, "number");
    assert.equal(typeof snaps[0].sha256, "string");
    // Metadata does NOT leak plugin data.
    assert.equal(snaps[0].plugins, undefined);
  } finally {
    await rmTempProject(dir);
  }
});

test("restore preserves `plugins` and `nodes[id].plugins` from the snapshot raw bytes", async () => {
  const dir = await createTempProject();
  try {
    const base = baseState();
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { createSnapshot } = await importFresh("./storage/state.ts");
    const { default: restore } = await importFresh("./cli/commands/restore.ts");
    const meta = await createSnapshot(dir, "force-init");
    await writeCanonicalState(dir, { nodes: {}, edges: [], initiatives: {}, log: [] });
    const out = await restore({
      statePath: dir,
      projectDir: dir,
      positional: [meta.id],
      flags: { as: "test-agent" },
    });
    assert.ok(out.snapshot);
    const after = await readState(dir);
    assertPluginDataPreserved(after);
  } finally {
    await rmTempProject(dir);
  }
});

test("end-to-end: snapshot with plugin data survives restore, then take/submit/accept cycles preserve it", async () => {
  const dir = await createTempProject();
  try {
    const base = baseState();
    seedPluginData(base);
    await writeCanonicalState(dir, base);
    const { createSnapshot } = await importFresh("./storage/state.ts");
    const { default: restore } = await importFresh("./cli/commands/restore.ts");
    const { default: take } = await importFresh("./cli/commands/take.ts");
    const meta = await createSnapshot(dir, "force-init");
    await writeCanonicalState(dir, { nodes: {}, edges: [], initiatives: {}, log: [] });
    await restore({
      statePath: dir,
      projectDir: dir,
      positional: [meta.id],
      flags: { as: "test-agent" },
    });
    // Now run the lifecycle on the restored state.
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
  } finally {
    await rmTempProject(dir);
  }
});
