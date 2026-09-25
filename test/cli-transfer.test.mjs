import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { dispatchCommand } from "../src/cli/dispatch.mjs";
import { bootstrapFencedState, readFencedState } from "../src/storage/ledger.mjs";
import { captureTransferSource } from "../src/kernel/transfer.mjs";

async function withProject(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-cli-transfer-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const projectDir = path.join(root, "project");
  await fs.mkdir(projectDir);
  try {
    await run({ root, projectDir });
  } finally {
    if (previousHome === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function payload(title = "remote source") {
  return {
    version: 4,
    revision: 0,
    nodes: { T1: { id: "T1", kind: "resolvable", subkind: "task", title, status: "open" } },
    edges: [],
    initiatives: { demo: { desc: "demo" } },
    log: [{ action: "source", agent: "author" }],
  };
}

test("push captures locally through kernel and sends one payload without retrying", async () => {
  await withProject(async ({ projectDir }) => {
    await bootstrapFencedState(projectDir);
    const source = await captureTransferSource({ sourceProjectDir: projectDir });
    let calls = 0;
    const backendClient = {
      type: "remote",
      async importTransfer(request) {
        calls += 1;
        assert.deepEqual(request, { payload: source, actor: "alice", overwrite: true });
        return { installed: true };
      },
    };
    assert.deepEqual(await dispatchCommand({
      command: "push", flags: { as: "alice", overwrite: "true" }, positional: [], projectDir,
      projectConfig: { project_id: "remote" }, backendClient,
    }), { installed: true });
    assert.equal(calls, 1);
  });
});

test("push reports an ambiguous timeout and never retries", async () => {
  await withProject(async ({ projectDir }) => {
    await bootstrapFencedState(projectDir);
    let calls = 0;
    const backendClient = {
      type: "remote",
      async importTransfer() {
        calls += 1;
        const error = new Error("timed out");
        error.code = "TRANSFER_OUTCOME_UNKNOWN";
        error.details = { applied: "unknown" };
        throw error;
      },
    };
    await assert.rejects(dispatchCommand({
      command: "push", flags: { as: "alice" }, positional: [], projectDir,
      projectConfig: { project_id: "remote" }, backendClient,
    }), { code: "TRANSFER_OUTCOME_UNKNOWN", details: { applied: "unknown" } });
    assert.equal(calls, 1);
  });
});

test("pull does not write locally until remote export succeeds, then installs via kernel", async () => {
  await withProject(async ({ projectDir }) => {
    let calls = 0;
    const unavailable = {
      type: "remote",
      async exportTransfer() { calls += 1; throw new Error("remote unavailable"); },
    };
    await assert.rejects(dispatchCommand({
      command: "pull", flags: { as: "alice" }, positional: [], projectDir,
      projectConfig: { project_id: "remote" }, backendClient: unavailable,
    }), /remote unavailable/);
    assert.equal(calls, 1);
    assert.equal(await readFencedState(projectDir), null);

    const backendClient = {
      type: "remote",
      async exportTransfer() { calls += 1; return payload(); },
    };
    const result = await dispatchCommand({
      command: "pull", flags: { as: "alice", overwrite: "false" }, positional: [], projectDir,
      projectConfig: { project_id: "remote" }, backendClient,
    });
    assert.equal(result.nodes.T1.title, "remote source");
    assert.equal(result.log.at(-1).action, "transfer.pull");
    assert.equal(result.log.at(-1).agent, "alice");
    assert.equal(calls, 2);
  });
});

test("transfer adapters reject invalid flags and require a remote backend", async () => {
  await withProject(async ({ projectDir }) => {
    for (const command of ["push", "pull"]) {
      await assert.rejects(dispatchCommand({
        command, flags: { as: "alice", overwrite: "yes" }, positional: [], projectDir,
        projectConfig: { project_id: "remote" },
        backendClient: { type: "remote", exportTransfer() {}, importTransfer() {} },
      }), { code: "INVALID_REQUEST" });
      await assert.rejects(dispatchCommand({
        command, flags: { as: "alice" }, positional: [], projectDir,
        backendClient: { type: "local" },
      }), { code: "REMOTE_UNSUPPORTED_OPERATION" });
    }
  });
});

test("HTTP and CLI adapters import only kernel transfer ports", async () => {
  for (const file of [
    "../src/server/http.mjs",
    "../src/cli/commands/push.mjs",
    "../src/cli/commands/pull.mjs",
  ]) {
    const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /storage\/(?:transfer|log)\.mjs/);
  }
});
