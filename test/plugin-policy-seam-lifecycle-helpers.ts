import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTempProject,
  rmTempProject,
  runCli,
  installPolicyFixture,
} from "./helpers.ts";

export async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-seam-lifecycle-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
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
      delete process.env.CLIMIER_AGENT;
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
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) {
    return null;
  }
  return JSON.parse(result.stdout);
}

export async function writeClimierJson(projectDir, value) {
  await fs.writeFile(
    path.join(projectDir, ".climier.json"),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

export async function baseClimierJson(projectDir) {
  await writeClimierJson(projectDir, {
    version: 1,
    project_id: "seam-lifecycle-project",
  });
}

export async function initAndSeed({ projectDir, mode }: { projectDir: string; mode?: string }) {
  if (mode !== undefined) {
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "seam-lifecycle-project",
      plugins: { "policy-fixture": { mode } },
    });
  } else {
    await baseClimierJson(projectDir);
  }
  await cli(["--project", projectDir, "init"]);
  await cli(["--project", projectDir, "add-initiative", "auth", "--desc", "auth", "--as", "setup"]);
  await cli([
    "--project", projectDir,
    "add-node", "T-auth-1",
    "--kind", "resolvable", "--subkind", "task", "--title", "t",
    "--initiative", "auth", "--as", "setup",
  ]);
}

export async function installAndTake(projectDir, as = "alice") {
  await installPolicyFixture(projectDir);
  await writeClimierJson(projectDir, {
    version: 1,
    project_id: "seam-lifecycle-project",
    plugins: { "policy-fixture": { mode: "allow" } },
  });
  return cli(["--project", projectDir, "take", "T-auth-1", "--as", as]);
}

export function entriesForAction(state, action) {
  return state.log.filter((entry) => entry.action === action);
}

export function assertPolicyError(result, code, action) {
  assert.equal(result.code, 1);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, false);
  assert.equal(data.error.code, code);
  assert.equal(data.error.details.action, action);
}
