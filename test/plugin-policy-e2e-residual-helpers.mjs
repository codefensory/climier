import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTempProject, rmTempProject, runCli, installPolicyFixture, uninstallPolicyFixture, POLICY_FIXTURE_DIR } from "./helpers.mjs";

export const FIXTURE_ID = "policy-fixture";
export const FIXTURE_COMMAND = "policy";

export async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-fixture-"));
  const projectDir = await createTempProject();
  const prev = { CLIMIER_HOME: process.env.CLIMIER_HOME, CLIMIER_AGENT: process.env.CLIMIER_AGENT };
  process.env.CLIMIER_HOME = home;
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (prev.CLIMIER_HOME === undefined) {
      delete process.env.CLIMIER_HOME;
    } else {
      process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    }
    if (prev.CLIMIER_AGENT === undefined) {
      process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    } else {
      process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    }
    await fs.rm(home, { recursive: true, force: true });
    await rmTempProject(projectDir);
  }
}

export async function cli(args) {
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `climier exited ${result.code}\n` +
        `argv: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) {
    return null;
  }
  return JSON.parse(result.stdout);
}

export async function writeClimierJson(projectDir, value) {
  await fs.writeFile(path.join(projectDir, ".climier.json"), JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function baseClimierJson(projectDir) {
  await writeClimierJson(projectDir, { version: 1, project_id: "policy-fixture-project" });
}

export { runCli, installPolicyFixture, uninstallPolicyFixture, POLICY_FIXTURE_DIR };
