import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../../package.json" with { type: "json" };
import { STATE_SCHEMA_VERSION } from "../../storage/state.ts";
import type { CommandContext } from "./contracts.ts";

declare const CLIMIER_DISTRIBUTION: string | undefined;
declare const CLIMIER_BUILD_COMMIT: string | undefined;

export const knownFlags = ["json"];

const MANIFEST_VERSION = 1;
const PACKAGE_VERSION = packageJson.version;

type ReleaseChannel = "stable" | "next";
type Distribution = "binary" | "npm" | "source-link" | "one-off";

function releaseChannel(version: string): ReleaseChannel {
  return version.includes("-") ? "next" : "stable";
}

function platform(): string {
  const operatingSystem = process.platform === "win32" ? "windows" : process.platform;
  return `${operatingSystem}-${process.arch}`;
}

function sourceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function distribution(): Distribution {
  if (typeof CLIMIER_DISTRIBUTION === "string") {
    return CLIMIER_DISTRIBUTION as Distribution;
  }
  const modulePath = fileURLToPath(import.meta.url);
  if (/[/\\]node_modules(?:[/\\]|$)/.test(modulePath)) {
    return "npm";
  }
  if (fsSync.existsSync(path.join(sourceRoot(), ".git"))) {
    return "source-link";
  }
  return "one-off";
}

function commit(): string {
  return typeof CLIMIER_BUILD_COMMIT === "string"
    ? CLIMIER_BUILD_COMMIT
    : process.env.CLIMIER_COMMIT ?? process.env.GITHUB_SHA ?? "unknown";
}

export function versionMetadata() {
  return {
    version: PACKAGE_VERSION,
    release_channel: releaseChannel(PACKAGE_VERSION),
    distribution: distribution(),
    commit: commit(),
    state_schema: STATE_SCHEMA_VERSION,
    manifest_version: MANIFEST_VERSION,
    platform: platform(),
    bun: process.versions.bun ?? "unknown",
  };
}

function usage(message: string): never {
  const error = new Error(`version: ${message}`);
  error.code = "CLI_USAGE_ERROR";
  throw error;
}

export default function versionCommand({ flags, positional }: CommandContext) {
  if (positional.length > 0) {
    usage("does not accept positional arguments");
  }
  if (flags.json === true || flags.json === "true") {
    return versionMetadata();
  }
  if (flags.json !== undefined && flags.json !== false && flags.json !== "false") {
    usage("--json must be a boolean");
  }
  return PACKAGE_VERSION;
}
