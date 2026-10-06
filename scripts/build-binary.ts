#!/usr/bin/env bun

import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const extraArgs = process.argv.slice(2);
const outfileIndex = extraArgs.findIndex((arg) => arg === "--outfile" || arg.startsWith("--outfile="));
const outputArgs = outfileIndex === -1 ? ["--outfile", path.join(root, "dist", "climier")] : [];
const args = [
  "build",
  "--compile",
  "--define",
  `CLIMIER_BUILD_VERSION=${JSON.stringify(packageJson.version)}`,
  ...outputArgs,
  ...extraArgs,
  path.join(root, "bin", "climier.ts"),
];

const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
