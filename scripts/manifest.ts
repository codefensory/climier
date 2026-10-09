#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
] as const;

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
export type ReleaseChannel = "stable" | "next";

export type ManifestArtifact = {
  url: string;
  sha256: string;
  size: number;
};

export type ReleaseManifest = {
  manifest_version: 1;
  version: string;
  release_channel: ReleaseChannel;
  state_schema: 1;
  min_bun: string;
  notes_url: string;
  artifacts: Record<Platform, ManifestArtifact>;
};

export type GenerateManifestOptions = {
  version: string;
  channel: ReleaseChannel;
  dist: string;
  out: string;
  repository?: string;
  minBun?: string;
};

const DEFAULT_REPOSITORY = "https://github.com/codefensory/climier";
const DEFAULT_MIN_BUN = ">=1.4";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function executableName(platform: Platform): string {
  return `climier-${platform}${platform === "windows-x64" ? ".exe" : ""}`;
}

function repositoryUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "").replace(/\.git$/u, "");
  if (!/^https?:\/\//u.test(trimmed)) {
    throw new Error("manifest: repository must be an http(s) URL");
  }
  return trimmed;
}

function releaseRef(version: string, channel: ReleaseChannel): string {
  return channel === "stable" ? `v${version}` : "next";
}

function validateOptions(options: GenerateManifestOptions): void {
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(`manifest: invalid version '${options.version}'`);
  }
  if (options.channel !== "stable" && options.channel !== "next") {
    throw new Error(`manifest: invalid channel '${String(options.channel)}'`);
  }
  if (!options.dist) {throw new Error("manifest: --dist requires a value");}
  if (!options.out) {throw new Error("manifest: --out requires a value");}
}

async function readArtifact(filePath: string, platform: Platform): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      throw new Error(`manifest: missing artifact for ${platform}: ${filePath}`, { cause: error });
    }
    throw error;
  }
}

export async function generateManifest(options: GenerateManifestOptions): Promise<ReleaseManifest> {
  validateOptions(options);
  const repository = repositoryUrl(options.repository ?? DEFAULT_REPOSITORY);
  const ref = releaseRef(options.version, options.channel);
  const artifacts = {} as Record<Platform, ManifestArtifact>;

  for (const platform of SUPPORTED_PLATFORMS) {
    const fileName = executableName(platform);
    const bytes = await readArtifact(path.join(options.dist, fileName), platform);
    artifacts[platform] = {
      url: `${repository}/releases/download/${ref}/${fileName}`,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  }

  const manifest: ReleaseManifest = {
    manifest_version: 1,
    version: options.version,
    release_channel: options.channel,
    state_schema: 1,
    min_bun: options.minBun ?? DEFAULT_MIN_BUN,
    notes_url: `${repository}/releases/tag/${ref}`,
    artifacts,
  };
  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {return inline.slice(name.length + 1);}
  const index = args.indexOf(name);
  if (index === -1) {return undefined;}
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`manifest: ${name} requires a value`);
  }
  return value;
}

function parseArgs(args: string[]): GenerateManifestOptions {
  const known = new Set(["--version", "--channel", "--dist", "--out", "--repository", "--min-bun"]);
  for (const arg of args) {
    const name = arg.split("=", 1)[0];
    if (arg.startsWith("--") && !known.has(name)) {
      throw new Error(`manifest: unknown option '${arg}'`);
    }
  }
  const version = optionValue(args, "--version");
  const channel = optionValue(args, "--channel") as ReleaseChannel | undefined;
  if (!version) {throw new Error("manifest: --version requires a value");}
  if (!channel) {throw new Error("manifest: --channel requires a value");}
  return {
    version,
    channel,
    dist: path.resolve(process.cwd(), optionValue(args, "--dist") ?? "dist"),
    out: path.resolve(process.cwd(), optionValue(args, "--out") ?? "manifest.json"),
    repository: optionValue(args, "--repository"),
    minBun: optionValue(args, "--min-bun"),
  };
}

function runningAsScript(): boolean {
  if (!process.argv[1]) {return false;}
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (runningAsScript()) {
  try {
    await generateManifest(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
