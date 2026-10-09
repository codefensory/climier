import packageJson from "../../../package.json" with { type: "json" };
import { detectDistribution } from "../../upgrade/distribution.ts";
import { STATE_SCHEMA_VERSION } from "../../storage/state.ts";
import type { CommandContext } from "./contracts.ts";

declare const CLIMIER_BUILD_COMMIT: string | undefined;

export const knownFlags = ["json"];

const MANIFEST_VERSION = 1;
const PACKAGE_VERSION = packageJson.version;

type ReleaseChannel = "stable" | "next";

function releaseChannel(version: string): ReleaseChannel {
  return version.includes("-") ? "next" : "stable";
}

function platform(): string {
  const operatingSystem = process.platform === "win32" ? "windows" : process.platform;
  return `${operatingSystem}-${process.arch}`;
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
    distribution: detectDistribution(),
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
