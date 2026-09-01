import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTempProject, readState, rmTempProject, runCli } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "climier.mjs");
const FIXTURE_DIR = path.join(ROOT, "test/fixtures/plugin-foundation");
const FIXTURE_ID = "foundation.acceptance";

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-foundation-concurrent-"));
  const projectDir = await createTempProject();
  const previousHome = process.env.CLIMIER_HOME;
  const previousAgent = process.env.CLIMIER_AGENT;
  process.env.CLIMIER_HOME = home;
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ projectDir });
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

function spawnCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("plugin foundation: concurrent API data writers preserve every project key and attribution", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await cli(["--project", projectDir, "init"]);
    await cli([
      "--project", projectDir, "--as", "seed", "add-initiative", "plugin-foundation",
    ]);
    await cli([
      "--project", projectDir, "--as", "seed", "add-task", "T-pf-concurrent",
      "--initiative", "plugin-foundation", "--title", "concurrent", "--body", "body",
      "--acceptance", "acceptance", "--blocked-by", "",
    ]);
    await cli(["--project", projectDir, "install", FIXTURE_DIR]);

    const count = 12;
    const results = await Promise.all(Array.from({ length: count }, (_, index) => spawnCli([
      "--project", projectDir,
      "--as", `writer-${index}`,
      "foundation", "project-set", `concurrent-${index}`, JSON.stringify(`value-${index}`),
    ])));
    for (const result of results) {
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(result.signal, null);
      assert.equal(JSON.parse(result.stdout).command, "project-set");
    }

    const state = await readState(projectDir);
    const data = state.plugins?.[FIXTURE_ID]?.data;
    for (let index = 0; index < count; index += 1) {
      assert.equal(data?.[`concurrent-${index}`], `value-${index}`);
    }
    const writes = state.log.filter(
      (entry) => entry.action === "plugin-data-set" && entry.plugin_id === FIXTURE_ID && entry.scope === "project",
    );
    assert.equal(writes.length, count);
    for (const entry of writes) {
      assert.equal(typeof entry.agent, "string");
      assert.equal("value" in entry, false);
    }
  });
});
