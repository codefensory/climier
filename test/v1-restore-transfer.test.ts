import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dispatchCommand } from "../src/cli/dispatch.ts";
import { initState } from "../src/kernel/state-operations.ts";
import { readFencedState } from "../src/storage/ledger.ts";
import { snapshotDir } from "../src/storage/state.ts";
import { asCaughtError } from "../src/contracts/errors.ts";
import type { ProjectState } from "../src/contracts/domain.ts";

async function withIsolatedProject(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-v1-restore-transfer-"));
  const previousHome = process.env.CLIMIER_HOME;
  const projectDir = path.join(root, "project");
  process.env.CLIMIER_HOME = path.join(root, "climier-home");
  await fs.mkdir(projectDir);
  try {
    await run({ projectDir });
  } finally {
    if (previousHome === undefined) {delete process.env.CLIMIER_HOME;}
    else {process.env.CLIMIER_HOME = previousHome;}
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeSnapshot(projectDir, id, state) {
  const dir = snapshotDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  await fs.writeFile(file, JSON.stringify(state), "utf8");
  await fs.writeFile(path.join(dir, `${id}.meta.json`), JSON.stringify({ id }), "utf8");
  return file;
}

for (const version of [2, 3, 4, 5]) {
  test(`restore rejects historical v${version} snapshots with path and migration guidance`, async () => {
    await withIsolatedProject(async ({ projectDir }) => {
      await initState({ projectDir });
      const id = `historical-v${version}`;
      const file = await writeSnapshot(projectDir, id, {
        version,
        nodes: {},
        edges: [],
        initiatives: {},
        log: [],
      });

      await assert.rejects(
        () => dispatchCommand({ command: "restore", positional: [id], flags: { as: "recovery" }, projectDir }),
        (rawError) => {
          const error = asCaughtError(rawError);
          return error.message.includes(file)
            && error.message.includes("restore a verified backup")
            && error.details?.path === file
            && error.details?.id === id;
        },
      );
    });
  });
}

test("restore installs a canonical snapshot and the restored project accepts a mutation", async () => {
  await withIsolatedProject(async ({ projectDir }) => {
    await initState({ projectDir });
    const target = {
      version: 1,
      fence_generation: 1,
      revision: 1,
      nodes: {},
      edges: [],
      initiatives: { before: { desc: "restored" } },
      log: [],
    };
    const id = "canonical-v1";
    await writeSnapshot(projectDir, id, target);

    await dispatchCommand({ command: "restore", positional: [id], flags: { as: "recovery" }, projectDir });
    await dispatchCommand({
      command: "add-initiative",
      positional: ["after-restore"],
      flags: { as: "alice", desc: "mutation after canonical restore" },
      projectDir,
    });

    const state = await readFencedState(projectDir) as ProjectState;
    assert.equal(state.version, 1);
    assert.ok(Number.isInteger(state.fence_generation));
    assert.equal(state.initiatives.before?.desc, "restored");
    assert.equal(state.initiatives["after-restore"]?.desc, "mutation after canonical restore");
    assert.equal(state.log.at(-1)?.action, "add-initiative");
  });
});
