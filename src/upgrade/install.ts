import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { codedError } from "../contracts/errors.ts";
import type { ManifestArtifact } from "./manifest-client.ts";

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type BinaryInstallOptions = {
  artifact: ManifestArtifact;
  targetPath?: string;
  fetchImpl?: FetchImplementation;
};

export type BinaryInstallResult = {
  targetPath: string;
  bytes: number;
  sha256: string;
};

function installError(code: string, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
  return codedError(code, `upgrade: ${message}`, details, cause);
}

function targetPath(options: BinaryInstallOptions): string {
  return options.targetPath ?? process.execPath;
}

function validateArtifact(artifact: ManifestArtifact): void {
  if (!artifact || typeof artifact.url !== "string" || !artifact.url.trim()) {
    throw installError("UPGRADE_ARTIFACT_INVALID", "manifest artifact has no download URL");
  }
  if (!/^[a-f0-9]{64}$/iu.test(artifact.sha256)) {
    throw installError("UPGRADE_ARTIFACT_INVALID", "manifest artifact has an invalid SHA-256", { sha256: artifact.sha256 });
  }
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function assertSha256(bytes: Uint8Array, expected: string): string {
  const actual = sha256(bytes);
  if (actual !== expected.toLowerCase()) {
    throw installError("UPGRADE_CHECKSUM_MISMATCH", "download checksum does not match the release manifest", {
      expected: expected.toLowerCase(),
      actual,
    });
  }
  return actual;
}

async function download(url: string, fetchImpl: FetchImplementation): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "follow" });
  } catch (cause) {
    throw installError("UPGRADE_DOWNLOAD_FAILED", "could not download the release artifact", { url }, cause);
  }
  if (!response.ok) {
    throw installError("UPGRADE_DOWNLOAD_FAILED", `release artifact returned HTTP ${response.status}`, {
      url,
      status: response.status,
    });
  }
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw installError("UPGRADE_DOWNLOAD_FAILED", "could not read the release artifact", { url }, cause);
  }
}

async function stagedBinary(target: string, bytes: Uint8Array, temporary: string): Promise<void> {
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") { throw cause; }
  }
  await fs.writeFile(temporary, bytes, { mode: mode ?? 0o755 });
  if (mode !== undefined) { await fs.chmod(temporary, mode); }
  const handle = await fs.open(temporary, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function replaceOnWindows(target: string, temporary: string): Promise<void> {
  const old = `${target}.old`;
  await fs.rm(old, { force: true });
  try {
    await fs.rename(target, old);
    await fs.rename(temporary, target);
  } catch (cause) {
    try {
      await fs.rm(target, { force: true });
      await fs.rename(old, target);
    } catch {
      // Preserve the original failure; the .old file is the recovery copy.
    }
    throw cause;
  }
  await fs.rm(old, { force: true });
}

async function replaceAtomically(target: string, bytes: Uint8Array): Promise<void> {
  const stagingDirectory = await fs.mkdtemp(path.join(path.dirname(target), ".climier-upgrade-"));
  const temporary = path.join(stagingDirectory, path.basename(target));
  try {
    await stagedBinary(target, bytes, temporary);
    if (process.platform === "win32") { await replaceOnWindows(target, temporary); }
    else { await fs.rename(temporary, target); }
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function installBinary(options: BinaryInstallOptions): Promise<BinaryInstallResult> {
  validateArtifact(options.artifact);
  const target = targetPath(options);
  const bytes = await download(options.artifact.url, options.fetchImpl ?? fetch);
  const digest = assertSha256(bytes, options.artifact.sha256);
  await replaceAtomically(target, bytes);
  return { targetPath: target, bytes: bytes.byteLength, sha256: digest };
}

export const downloadAndInstallBinary = installBinary;
