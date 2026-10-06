import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetNames = {
  linux: { x64: "linux-x64", arm64: "linux-arm64" },
  darwin: { x64: "darwin-x64", arm64: "darwin-arm64" },
  win32: { x64: "windows-x64" },
};
const target = targetNames[process.platform]?.[process.arch];
const targetFlag = target ? `bun-${target}` : undefined;

type ExecFileError = {
  code?: string | number;
  stdout?: string;
  stderr?: string;
};

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { ...options, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const execError = typeof error === "object" && error !== null ? error as ExecFileError : {};
    throw new Error(
      `${command} ${args.join(" ")} failed (${execError.code}):\n${execError.stdout ?? ""}${execError.stderr ?? ""}`,
      { cause: error },
    );
  }
}

async function seedPlugin(home, project) {
  const installed = path.join(home, "plugins", "installed", "binary-plugin");
  await fs.mkdir(installed, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({
    name: "binary-plugin",
    version: "1.0.0",
    type: "module",
    climier: { id: "binary-plugin", command: "binary-plugin", entry: "./climier.mjs", api: 1 },
  }) + "\n");
  await fs.writeFile(
    path.join(installed, "climier.mjs"),
    "export default { commands: { probe: (args, api) => ({ loaded: true, args, project: api.runtime.project_dir }) } };\n",
  );
}

async function buildBinary(dist, env) {
  await run(process.execPath, [
    "scripts/build-binary.ts", "--target", targetFlag, "--output-dir", dist,
  ], { cwd: root, env });
  return path.join(dist, `climier-${target}${process.platform === "win32" ? ".exe" : ""}`);
}

test("compiled binary loads an installed external .mjs plugin", { skip: !targetFlag }, async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-binary-plugin-"));
  const project = path.join(rootDir, "project");
  const env = { ...process.env, CLIMIER_HOME: path.join(rootDir, "home") };
  try {
    await seedPlugin(env.CLIMIER_HOME, project);
    const executable = await buildBinary(path.join(rootDir, "dist"), env);
    await run(executable, ["--project", project, "init"], { env });
    const { stdout } = await run(executable, [
      "--project", project, "--as", "binary-test", "binary-plugin", "probe", "--external",
    ], { env });
    assert.deepEqual(JSON.parse(stdout), {
      loaded: true,
      args: ["--project", project, "--as", "binary-test", "--external"],
      project,
    });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
