import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createTempProject,
  readState,
  rmTempProject,
  runCli,
  stateFilePath,
  writeState,
} from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "test/fixtures/plugin-foundation");
const FIXTURE_ID = "foundation.acceptance";
const FIXTURE_COMMAND = "foundation";

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-foundation-"));
  const projectDir = await createTempProject();
  const previousHome = process.env.CLIMIER_HOME;
  const previousAgent = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_HOME = home;
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    if (previousAgent === undefined) delete process.env.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = previousAgent;
    await fs.rm(home, { recursive: true, force: true });
    await rmTempProject(projectDir);
  }
}

async function cli(args) {
  const result = await runCli(args);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function cliFailure(args) {
  const result = await runCli(args);
  assert.notEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function seed(projectDir) {
  await cli(["--project", projectDir, "init"]);
  await cli([
    "--project", projectDir, "--as", "seed",
    "add-initiative", "plugin-foundation", "--desc", "Plugin foundation acceptance",
  ]);
  await cli([
    "--project", projectDir, "--as", "seed", "add-task", "T-pf-target",
    "--initiative", "plugin-foundation", "--title", "Acceptance target",
    "--body", "target", "--acceptance", "target exists", "--blocked-by", "",
  ]);

  const state = await readState(projectDir);
  state.plugins = {
    "other.plugin": { data: { hidden: "other-secret" } },
    [FIXTURE_ID]: { data: { visible: "fixture-project" } },
  };
  state.nodes["T-pf-target"].plugins = {
    "other.plugin": { data: { hidden: "other-node-secret" } },
    [FIXTURE_ID]: { data: { visible: "fixture-node" } },
  };
  await writeState(projectDir, state);
}

test("plugin-foundation fixture is public-api-only and exercises the complete acceptance flow", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, "package.json"), "utf8"));
  assert.equal(packageJson.type, "module");
  assert.deepEqual(packageJson.climier, {
    id: FIXTURE_ID,
    command: FIXTURE_COMMAND,
    entry: "./climier.mjs",
    api: 3,
  });
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.equal(key in packageJson, false, `fixture must not declare ${key}`);
  }
  const entrypoint = await fs.readFile(path.join(FIXTURE_DIR, "climier.mjs"), "utf8");
  assert.doesNotMatch(entrypoint, /(?:from|import)\s*["'][^"']*src\//);

  await withFreshEnv(async ({ home, projectDir }) => {
    await seed(projectDir);
    const installed = await cli(["--project", projectDir, "install", FIXTURE_DIR]);
    assert.equal(installed.plugin.id, FIXTURE_ID);

    const snapshot = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "snapshot",
    ]);
    assert.equal(snapshot.command, "snapshot");
    assert.deepEqual(Object.keys(snapshot.snapshot.plugins), [FIXTURE_ID]);
    assert.equal(snapshot.snapshot.plugins["other.plugin"], undefined);
    assert.equal(snapshot.snapshot.nodes["T-pf-target"].plugins["other.plugin"], undefined);
    assert.equal(snapshot.snapshot.derived["T-pf-target"], "ready");

    const value = { secret: "not-a-log-value", nested: [true, null, 3] };
    await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "data-set",
      "T-pf-target", "result", JSON.stringify(value),
    ]);
    const data = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "data-get",
      "T-pf-target", "result",
    ]);
    assert.deepEqual(data.node, value);
    assert.deepEqual(data.project, value);
    const afterSet = await readState(projectDir);
    assert.deepEqual(afterSet.nodes["T-pf-target"].plugins[FIXTURE_ID].data.result, value);
    assert.deepEqual(afterSet.plugins[FIXTURE_ID].data.result, value);
    assert.ok(afterSet.log.some((entry) => entry.action === "plugin-data-set"));
    assert.equal(afterSet.log.some((entry) => JSON.stringify(entry).includes(value.secret)), false);

    const deleted = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "data-delete",
      "T-pf-target", "result",
    ]);
    assert.deepEqual(deleted.node, { removed: true });
    assert.deepEqual(deleted.project, { removed: true });
    const deletedAgain = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "data-delete",
      "T-pf-target", "result",
    ]);
    assert.deepEqual(deletedAgain.node, { removed: false });
    assert.deepEqual(deletedAgain.project, { removed: false });
    const afterDelete = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "data-get",
      "T-pf-target", "result",
    ]);
    assert.equal(afterDelete.node, null);
    assert.equal(afterDelete.project, null);

    await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "runtime-write", "restart-marker",
    ]);
    const runtime = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "runtime-read",
    ]);
    assert.equal(runtime.marker, "restart-marker");
    assert.match(runtime.dataDir, new RegExp(`${FIXTURE_ID.replace(".", "\\.")}$`));
    assert.ok((await fs.stat(runtime.dataDir)).isDirectory());

    const beforeShell = (await cli(["--project", projectDir, "state"])).revision;
    // The public shell path is deliberately state -> batch -> state. The
    // revision read from state is the batch CAS and the next state proves
    // the repair was one atomic commit.
    const beforeState = await cli(["--project", projectDir, "state"]);
    const batchFile = path.join(projectDir, "acceptance-batch.json");
    await fs.writeFile(batchFile, JSON.stringify({
      if_state_revision: beforeState.revision,
      operations: [
        { op: "task.create", input: {
          id: "T-pf-shell-a", initiative: "plugin-foundation", title: "shell a",
          body: "a", acceptance: "a",
        } },
        { op: "task.create", input: {
          id: "T-pf-shell-b", initiative: "plugin-foundation", title: "shell b",
          body: "b", acceptance: "b",
        } },
        { op: "edge.add", input: { from: "T-pf-shell-a", to: "T-pf-shell-b", type: "BLOCKS" } },
      ],
    }), "utf8");
    const shellBatch = await cli([
      "--project", projectDir, "batch", "--file", batchFile, "--as", "shell",
    ]);
    assert.equal(shellBatch.ok, true);
    const afterShell = await cli(["--project", projectDir, "state"]);
    assert.equal(afterShell.revision, beforeState.revision + 1);
    assert.equal(afterShell.derived["T-pf-shell-b"], "blocked");
    assert.equal(afterShell.nodes["T-pf-shell-a"].id, "T-pf-shell-a");
    assert.equal(beforeShell, beforeState.revision);

    const repair = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "repair",
    ]);
    assert.equal(repair.command, "repair");
    assert.equal(repair.batch.ok, true);
    assert.equal(repair.batch.results.length, 3);
    assert.equal(repair.batch.revision_after, repair.batch.revision_before + 1);

    const rollback = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "rollback",
    ]);
    assert.equal(rollback.error.code, "BATCH_OPERATION_FAILED");
    assert.equal(rollback.error.details.operation_index, 1);
    const rollbackState = await readState(projectDir);
    assert.equal(rollbackState.nodes["T-pf-rollback"], undefined);

    const staleCas = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "cas",
    ]);
    assert.equal(staleCas.error.code, "STATE_REVISION_CONFLICT");

    const apiCycle = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "api-cycle",
    ]);
    assert.equal(apiCycle.error.code, "CYCLE_DETECTED");
    const batchCycle = await cli([
      "--project", projectDir, "--as", "acceptance", FIXTURE_COMMAND, "batch-cycle",
    ]);
    assert.equal(batchCycle.error.code, "BATCH_OPERATION_FAILED");
    assert.equal(batchCycle.error.details.cause.code, "CYCLE_DETECTED");

    const cliCycle = await cliFailure([
      "--project", projectDir, "--as", "shell", "add-edge",
      "T-pf-shell-b", "T-pf-shell-a", "--type", "BLOCKS",
    ]);
    assert.equal(cliCycle.error.code, "CYCLE_DETECTED");

    const finalState = await readState(projectDir);
    assert.equal(finalState.nodes["T-pf-shell-a"].id, "T-pf-shell-a");
    assert.equal(finalState.nodes["T-pf-rollback"], undefined);
    assert.equal(finalState.nodes["T-pf-target"].plugins["other.plugin"].data.hidden, "other-node-secret");
    assert.ok(finalState.log.every((entry) => !JSON.stringify(entry).includes("not-a-log-value")));
    assert.equal(stateFilePath(projectDir).startsWith(path.join(home, "projects")), true);
  });
});
