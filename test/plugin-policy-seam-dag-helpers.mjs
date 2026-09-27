import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createTempProject,
  rmTempProject,
  runCli,
} from "./helpers.mjs";

export async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-seam-dag-"));
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

export function runCliRaw(args, { cwd } = {}) {
  return runCli(args, { cwd });
}

export async function cli(args, { cwd } = {}) {
  const result = await runCliRaw(args, { cwd });
  if (result.code !== 0) {
    throw new Error(
      `climier exited ${result.code}\nargv: ${JSON.stringify(args)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
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

export async function baseClimierJson(projectDir, namespace) {
  const metaRaw = await fs.readFile(path.join(projectDir, ".climier.json"), "utf8");
  const meta = JSON.parse(metaRaw);
  await writeClimierJson(projectDir, {
    ...meta,
    plugins: { "policy-fixture": namespace },
  });
}

export async function initProject(projectDir) {
  const result = await runCliRaw(["init"], { cwd: projectDir });
  if (result.code !== 0) {
    throw new Error(
      `init failed (exit ${result.code})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

export async function registerInitiative(projectDir, name) {
  await cli(
    ["add-initiative", name, "--desc", `desc-${name}`, "--as", "init-agent"],
    { cwd: projectDir },
  );
}

export async function recorded(projectDir) {
  return cli(["--project", projectDir, "--as", "init-agent", "policy", "recorded"]);
}

export function buildEnvNamespace(mode, extra = {}) {
  return { mode, ...extra };
}

export function hasBlocksEdge(status, from, to) {
  return (status.edges || []).some(
    (edge) => edge.from === from && edge.to === to && edge.type === "BLOCKS",
  );
}

export function missingInitiativeError(error) {
  return error.code === "MISSING_FIELD" || error.code === "INITIATIVE_NOT_FOUND";
}
