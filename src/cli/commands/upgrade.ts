import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import packageJson from "../../../package.json" with { type: "json" };

import { codedError } from "../../contracts/errors.ts";
import { STATE_SCHEMA_VERSION, stateFile } from "../../storage/state.ts";
import { detectDistribution, type Distribution } from "../../upgrade/distribution.ts";
import {
  createManifestClient,
  type ManifestClientOptions,
  type ReleaseManifest,
} from "../../upgrade/manifest-client.ts";
import { installBinary } from "../../upgrade/install.ts";
import type { CommandContext } from "./contracts.ts";

export const knownFlags = ["check", "version"];
const PACKAGE_VERSION = packageJson.version;

function upgradeError(code: string, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
  return codedError(code, `upgrade: ${message}`, details, cause);
}

function requestedVersion(raw: string | boolean | undefined): string | undefined {
  if (raw === undefined) { return undefined; }
  if (raw === true || !String(raw).trim()) {
    throw upgradeError("CLI_USAGE_ERROR", "--version requires a semver value");
  }
  const value = String(raw);
  if (!semverCore(value)) {
    throw upgradeError("CLI_USAGE_ERROR", "--version must be valid semver", { version: value });
  }
  return value;
}

function checkRequested(raw: string | boolean | undefined): boolean {
  if (raw === undefined || raw === false || raw === "false") { return false; }
  if (raw === true || raw === "true") { return true; }
  throw upgradeError("CLI_USAGE_ERROR", "--check must be a boolean");
}

function semverCore(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: string, right: string): number {
  const a = semverCore(left);
  const b = semverCore(right);
  if (!a || !b) { throw upgradeError("UPDATE_MANIFEST_INVALID", "release version must be valid semver"); }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) { return a[index] > b[index] ? 1 : -1; }
  }
  return 0;
}

function platform(): string {
  return `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

function manifestOptions(): ManifestClientOptions {
  return {
    ...(process.env.CLIMIER_UPDATE_REPOSITORY ? { repository: process.env.CLIMIER_UPDATE_REPOSITORY } : {}),
    ...(process.env.CLIMIER_UPDATE_TIMEOUT_MS ? { timeoutMs: Number(process.env.CLIMIER_UPDATE_TIMEOUT_MS) } : {}),
  };
}

async function flowRunIsActive(projectDir: string): Promise<boolean> {
  const lockPath = path.join(path.dirname(stateFile(projectDir)), ".lock");
  try {
    await fs.access(lockPath);
    return true;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") { return false; }
    throw cause;
  }
}

function migrationInfo(manifest: ReleaseManifest) {
  const required = manifest.state_schema > STATE_SCHEMA_VERSION;
  return {
    state_schema: manifest.state_schema,
    migration_required: required,
    ...(required ? { migration_warning: `This release requires state schema ${manifest.state_schema}; run climier migrate before using it.` } : {}),
  };
}

function artifactFor(manifest: ReleaseManifest) {
  const artifact = manifest.artifacts[platform()];
  if (!artifact) {
    throw upgradeError("UPGRADE_PLATFORM_UNSUPPORTED", `release has no artifact for ${platform()}`, { platform: platform() });
  }
  return artifact;
}

type PackageManager = "bun" | "npm";

function packageManager(): PackageManager {
  if (process.env.CLIMIER_PACKAGE_MANAGER === "npm" || process.env.npm_config_user_agent?.startsWith("npm/")) {
    return "npm";
  }
  return "bun";
}

async function delegateToPackageManager(version: string): Promise<{ package_manager: PackageManager; command: string[] }> {
  const manager = packageManager();
  const executable = manager === "npm" ? process.env.CLIMIER_NPM_CMD ?? "npm" : process.env.CLIMIER_BUN_CMD ?? "bun";
  const args = manager === "bun"
    ? ["add", "-g", `climier@${version}`]
    : ["i", "-g", `climier@${version}`];
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    let child;
    try {
      child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (cause) {
      reject(upgradeError("UPGRADE_PACKAGE_MANAGER_FAILED", `${manager} could not be started`, { manager }, cause));
      return;
    }
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (cause) => reject(upgradeError("UPGRADE_PACKAGE_MANAGER_FAILED", `${manager} could not be started`, { manager }, cause)));
    child.on("close", (code) => {
      if (code === 0) { resolve(); return; }
      reject(upgradeError("UPGRADE_PACKAGE_MANAGER_FAILED", `${manager} failed with exit code ${code ?? -1}`, {
        manager,
        exit_code: code ?? -1,
        stderr_tail: stderr.slice(-2000),
      }));
    });
  });
  return { package_manager: manager, command: [executable, ...args] };
}

async function loadManifest(version: string | undefined, options: ManifestClientOptions): Promise<ReleaseManifest> {
  const client = createManifestClient(options);
  return version ? client.fetchManifestForVersion(version) : client.fetchManifest();
}

function checkResult(manifest: ReleaseManifest, distribution: Distribution) {
  return {
    distribution,
    current_version: PACKAGE_VERSION,
    latest_version: manifest.version,
    update_available: compareVersions(manifest.version, PACKAGE_VERSION) > 0,
    ...migrationInfo(manifest),
    checked: true,
  };
}

const SOURCE_LINK_INSTRUCTIONS = "Source-link installations are not updated automatically. Pull the checkout and reinstall with bun install, or rebuild the binary.";

function unsupportedDistributionResult(distribution: Distribution, version: string | undefined) {
  if (distribution === "one-off") {
    throw upgradeError("UPGRADE_UNSUPPORTED_DISTRIBUTION", "this one-off executable cannot be upgraded automatically", { distribution });
  }
  if (distribution === "source-link") {
    return {
      distribution,
      current_version: PACKAGE_VERSION,
      ...(version ? { target_version: version } : {}),
      state_schema: STATE_SCHEMA_VERSION,
      migration_required: false,
      updated: false,
      instructions: SOURCE_LINK_INSTRUCTIONS,
    };
  }
  return undefined;
}

function validateManifestTarget(manifest: ReleaseManifest, version: string | undefined): void {
  if (version && manifest.version !== version) {
    throw upgradeError("UPDATE_MANIFEST_INVALID", "requested version does not match its release manifest", {
      requested_version: version,
      manifest_version: manifest.version,
    });
  }
}

async function applyManifestUpgrade(manifest: ReleaseManifest, distribution: Distribution, version: string | undefined) {
  const comparison = compareVersions(manifest.version, PACKAGE_VERSION);
  if (!version && comparison < 0) {
    throw upgradeError("UPGRADE_DOWNGRADE_REQUIRES_VERSION", "a downgrade requires an explicit --version");
  }
  const result = {
    distribution,
    current_version: PACKAGE_VERSION,
    target_version: manifest.version,
    ...migrationInfo(manifest),
  };
  if (comparison === 0) { return { ...result, updated: false, already_current: true }; }
  if (distribution === "npm") {
    return { ...result, ...(await delegateToPackageManager(manifest.version)), updated: true };
  }
  const installed = await installBinary({ artifact: artifactFor(manifest) });
  return { ...result, ...installed, updated: true };
}

export default async function upgrade({ flags, projectDir }: CommandContext) {
  if (await flowRunIsActive(projectDir)) {
    throw upgradeError("UPGRADE_FLOW_ACTIVE", "an active Flow run was detected; wait for it to finish before upgrading");
  }
  const check = checkRequested(flags.check);
  const version = requestedVersion(flags.version);
  const distribution = detectDistribution();
  if (!check) {
    const unsupported = unsupportedDistributionResult(distribution, version);
    if (unsupported) { return unsupported; }
  }
  const manifest = await loadManifest(version, manifestOptions());
  validateManifestTarget(manifest, version);
  return check ? checkResult(manifest, distribution) : applyManifestUpgrade(manifest, distribution, version);
}

export { delegateToPackageManager, flowRunIsActive };
