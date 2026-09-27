import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTempProject, rmTempProject, runCli, writeCanonicalState } from "./helpers.mjs";

const task = (id, status) => ({
  id,
  kind: "resolvable",
  subkind: "task",
  title: id,
  initiative: "supersession-test",
  status,
});

function fixture(replacementStatus) {
  return {
    version: 2,
    initiatives: { "supersession-test": { desc: "CLI supersession fixture" } },
    nodes: {
      replacement: task("replacement", replacementStatus),
      canceled: task("canceled", "canceled"),
      dependent: task("dependent", "open"),
    },
    edges: [
      { from: "replacement", to: "canceled", type: "SUPERSEDES" },
      { from: "canceled", to: "dependent", type: "BLOCKS" },
    ],
    log: [],
  };
}

async function runCliProjection(project, home, args) {
  const result = await runCli(["--project", project, ...args], {
    env: { CLIMIER_HOME: home },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("CLI status and context project replacement-chain readiness from an isolated CLIMIER_HOME", async () => {
  const previousHome = process.env.CLIMIER_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-supersession-home-"));
  const project = await createTempProject();
  try {
    process.env.CLIMIER_HOME = home;
    const initialized = await runCli(["--project", project, "init"], {
      env: { CLIMIER_HOME: home },
    });
    assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);

    await writeCanonicalState(project, fixture("done"));
    const satisfiedStatus = await runCliProjection(project, home, ["status"]);
    assert.deepEqual(satisfiedStatus.tasks.ready.map((node) => node.id), ["dependent"]);
    assert.deepEqual(satisfiedStatus.tasks.blocked, []);
    const satisfiedContext = await runCliProjection(project, home, ["context", "dependent"]);
    assert.equal(satisfiedContext.derived_status, "ready");
    const canceledBlocker = satisfiedContext.blocking.find((entry) => entry.node.id === "canceled");
    assert.equal(canceledBlocker.satisfied, true);

    await writeCanonicalState(project, fixture("open"));
    const pendingStatus = await runCliProjection(project, home, ["status"]);
    assert.deepEqual(pendingStatus.tasks.ready.map((node) => node.id), ["replacement"]);
    assert.deepEqual(pendingStatus.tasks.blocked.map((node) => node.id), ["dependent"]);
    const pendingContext = await runCliProjection(project, home, ["context", "dependent"]);
    assert.equal(pendingContext.derived_status, "blocked");
    assert.equal(pendingContext.blocking.some((entry) => entry.node.id === "canceled"), true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.CLIMIER_HOME;
    } else {
      process.env.CLIMIER_HOME = previousHome;
    }
    await rmTempProject(project);
    await fs.rm(home, { recursive: true, force: true });
  }
});
