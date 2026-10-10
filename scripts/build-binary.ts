#!/usr/bin/env bun

import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BuildTarget = {
  bunTarget: string;
  executableSuffix: string;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets: Readonly<Record<string, BuildTarget>> = Object.freeze({
  "linux-x64": { bunTarget: "bun-linux-x64", executableSuffix: "" },
  "linux-arm64": { bunTarget: "bun-linux-arm64", executableSuffix: "" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", executableSuffix: "" },
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", executableSuffix: "" },
  "windows-x64": { bunTarget: "bun-windows-x64", executableSuffix: ".exe" },
});

const entrypoints = Object.freeze([
  { name: "climier", path: path.join(root, "bin", "climier.ts") },
]);

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) {return inline.slice(prefix.length);}

  const index = args.indexOf(name);
  if (index === -1) {return undefined;}
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`build-binary: ${name} requires a value`);
  }
  return value;
}

function removeOption(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      index += 1;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {continue;}
    result.push(arg);
  }
  return result;
}

function targetName(value: string): string {
  const name = value.startsWith("bun-") ? value.slice(4) : value;
  if (!(name in targets)) {
    throw new Error(`build-binary: unsupported target '${value}'; expected one of ${Object.keys(targets).join(", ")}`);
  }
  return name;
}

function outputPath(outputDir: string, binaryName: string, selectedTarget: string | undefined, explicitOutfile: string | undefined): string {
  if (explicitOutfile) {
    return explicitOutfile;
  }
  const suffix = selectedTarget ? `-${selectedTarget}` : "";
  let extension = "";
  if (selectedTarget) {
    extension = targets[selectedTarget].executableSuffix;
  } else if (process.platform === "win32") {
    extension = ".exe";
  }
  return path.join(outputDir, `${binaryName}${suffix}${extension}`);
}

const originalArgs = process.argv.slice(2);
if (originalArgs.includes("--list-targets")) {
  process.stdout.write(`${Object.keys(targets).join("\n")}\n`);
  process.exit(0);
}

const requestedTarget = optionValue(originalArgs, "--target");
const selectedTarget = requestedTarget ? targetName(requestedTarget) : undefined;
const outputDir = path.resolve(root, optionValue(originalArgs, "--output-dir") ?? "dist");
const requestedOutfile = optionValue(originalArgs, "--outfile");
const explicitOutfile = requestedOutfile ? path.resolve(root, requestedOutfile) : undefined;
const passthroughArgs = removeOption(removeOption(removeOption(originalArgs, "--target"), "--output-dir"), "--outfile");
const uiIndex = path.join(root, "ui", "dist", "index.html");
try {
  if (!(await fs.stat(uiIndex)).isFile()) {
    throw new Error();
  }
} catch {
  throw new Error(`build-binary: UI build is missing at ${uiIndex}; run \`bun run build:ui\` before building the standalone binary`);
}
await fs.mkdir(outputDir, { recursive: true });

for (const entrypoint of entrypoints) {
  const output = outputPath(outputDir, entrypoint.name, selectedTarget, explicitOutfile);
  const args = [
    "build",
    "--compile",
    "--asset",
    "ui/dist",
    ...(selectedTarget ? ["--target", targets[selectedTarget].bunTarget] : []),
    "--define",
    `CLIMIER_DISTRIBUTION=${JSON.stringify("binary")}`,
    "--outfile",
    output,
    ...passthroughArgs,
    entrypoint.path,
  ];

  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) {throw result.error;}
  if (result.status !== 0) {
    throw new Error(`build-binary: failed to build ${entrypoint.name}${selectedTarget ? ` for ${selectedTarget}` : ""}`);
  }
}
