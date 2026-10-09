import { codedError, type CodedError } from "../contracts/errors.ts";

export const DEFAULT_RELEASE_REPOSITORY = "https://github.com/codefensory/climier";
export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 10_000;
export const STABLE_MANIFEST_PATH = "/releases/latest/download/manifest.json";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
};

export type ManifestArtifact = {
  url: string;
  sha256: string;
  size: number;
};

export type ReleaseManifest = {
  manifest_version: 1;
  version: string;
  release_channel: "stable" | "next";
  state_schema: number;
  min_bun: string;
  notes_url: string;
  artifacts: Record<string, ManifestArtifact>;
};

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ManifestClientOptions = {
  repository?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
};

export type ManifestClient = {
  fetchManifest: () => Promise<ReleaseManifest>;
  fetchManifestForVersion: (version: string) => Promise<ReleaseManifest>;
};

export type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  manifest: ReleaseManifest;
};

function invalidManifest(message: string, details: Record<string, unknown> = {}, cause?: unknown): CodedError {
  return codedError("UPDATE_MANIFEST_INVALID", `upgrade: ${message}`, details, cause);
}

function unreachable(message: string, details: Record<string, unknown> = {}, cause?: unknown): CodedError {
  return codedError("UPDATE_CHECK_UNREACHABLE", `upgrade: ${message}`, details, cause);
}

function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== "string") {return null;}
  const match = VERSION_PATTERN.exec(value);
  if (!match) {return null;}
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}

function compareCoreVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) {return left[field] > right[field] ? 1 : -1;}
  }
  return 0;
}

function comparePrereleases(left: ParsedVersion, right: ParsedVersion): number {
  if (left.prerelease === right.prerelease) {return 0;}
  if (left.prerelease === undefined) {return 1;}
  if (right.prerelease === undefined) {return -1;}
  return left.prerelease > right.prerelease ? 1 : -1;
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  const coreComparison = compareCoreVersions(left, right);
  return coreComparison === 0 ? comparePrereleases(left, right) : coreComparison;
}

/** Return the highest valid version that has no prerelease identifier. */
export function selectStableVersion(versions: readonly string[]): string | null {
  let selected: { raw: string; parsed: ParsedVersion } | undefined;
  for (const raw of versions) {
    const parsed = parseVersion(raw);
    if (!parsed || parsed.prerelease !== undefined) {continue;}
    if (selected === undefined || compareParsedVersions(parsed, selected.parsed) > 0) {
      selected = { raw, parsed };
    }
  }
  return selected?.raw ?? null;
}

function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    throw invalidManifest("version must be valid semver", { left, right });
  }
  return compareParsedVersions(parsedLeft, parsedRight);
}

function repositoryUrl(repository: string): string {
  let url: URL;
  try {
    url = new URL(repository);
  } catch (cause) {
    throw unreachable("release repository URL is invalid", { repository }, cause);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw unreachable("release repository URL must be an HTTP(S) origin or path", { repository });
  }
  return url.toString().replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateManifestShape(value: Record<string, unknown>): void {
  if (value.manifest_version !== 1) {
    throw invalidManifest("manifest_version must be 1", { manifest_version: value.manifest_version });
  }
  if (value.release_channel !== "stable") {
    throw invalidManifest("stable endpoint returned a non-stable manifest", { release_channel: value.release_channel });
  }
  if (typeof value.state_schema !== "number" || !Number.isSafeInteger(value.state_schema) || value.state_schema < 1) {
    throw invalidManifest("state_schema must be a positive integer");
  }
}

function validateManifestMetadata(value: Record<string, unknown>): void {
  if (typeof value.min_bun !== "string") {throw invalidManifest("manifest is missing min_bun");}
  if (typeof value.notes_url !== "string") {throw invalidManifest("manifest is missing notes_url");}
  if (!isRecord(value.artifacts)) {throw invalidManifest("manifest is missing artifacts");}
}

function validateManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) {throw invalidManifest("response must be a JSON object");}
  const version = parseVersion(value.version);
  if (!version || version.prerelease !== undefined) {
    throw invalidManifest("stable manifest version must not be a prerelease", { version: value.version });
  }
  validateManifestShape(value);
  validateManifestMetadata(value);
  return value as unknown as ReleaseManifest;
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("upgrade: timeoutMs must be a positive integer");
  }
}

async function requestResponse(url: string, fetchImpl: FetchImplementation, signal: AbortSignal): Promise<Response> {
  return fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
}

async function readManifestResponse(response: Response, url: string): Promise<ReleaseManifest> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw invalidManifest("response was not valid JSON", { url }, cause);
  }
  return validateManifest(body);
}

async function requestManifestResponse({
  url,
  fetchImpl,
  signal,
  timeoutPromise,
  timedOut,
  timeoutMs,
}: {
  url: string;
  fetchImpl: FetchImplementation;
  signal: AbortSignal;
  timeoutPromise: Promise<Response>;
  timedOut: () => boolean;
  timeoutMs: number;
}): Promise<Response> {
  try {
    return await Promise.race([requestResponse(url, fetchImpl, signal), timeoutPromise]);
  } catch (cause) {
    throw unreachable(
      timedOut() ? `manifest request timed out after ${timeoutMs}ms` : "could not reach release manifest",
      { url, ...(timedOut() ? { timeout_ms: timeoutMs } : {}) },
      cause,
    );
  }
}

async function requestManifest({
  repository,
  timeoutMs,
  fetchImpl,
  manifestPath = STABLE_MANIFEST_PATH,
}: Required<Pick<ManifestClientOptions, "repository" | "timeoutMs" | "fetchImpl">> & { manifestPath?: string }): Promise<ReleaseManifest> {
  const url = `${repositoryUrl(repository)}${manifestPath}`;
  const controller = new AbortController();
  let timedOut = false;
  let timeout!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(unreachable(`manifest request timed out after ${timeoutMs}ms`, { url, timeout_ms: timeoutMs }));
    }, timeoutMs);
  });

  try {
    const response = await requestManifestResponse({
      url,
      fetchImpl,
      signal: controller.signal,
      timeoutPromise,
      timedOut: () => timedOut,
      timeoutMs,
    });
    if (!response.ok) {
      throw unreachable(`manifest request returned HTTP ${response.status}`, { url, status: response.status });
    }
    return await readManifestResponse(response, url);
  } finally {
    clearTimeout(timeout);
  }
}

export function createManifestClient(options: ManifestClientOptions = {}): ManifestClient {
  const repository = options.repository ?? DEFAULT_RELEASE_REPOSITORY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  validateTimeout(timeoutMs);
  return Object.freeze({
    fetchManifest: () => requestManifest({ repository, timeoutMs, fetchImpl }),
    fetchManifestForVersion: (version: string) => {
      if (!parseVersion(version)) {
        throw invalidManifest("requested version must be valid semver", { version });
      }
      return requestManifest({
        repository,
        timeoutMs,
        fetchImpl,
        manifestPath: `/releases/download/v${encodeURIComponent(version)}/manifest.json`,
      });
    },
  });
}

export async function fetchLatestManifest(options: ManifestClientOptions = {}): Promise<ReleaseManifest> {
  return createManifestClient(options).fetchManifest();
}

export async function fetchVersionManifest(version: string, options: ManifestClientOptions = {}): Promise<ReleaseManifest> {
  return createManifestClient(options).fetchManifestForVersion(version);
}

export const fetchStableManifest = fetchLatestManifest;

export function checkForUpdate(
  currentVersion: string,
  options?: ManifestClientOptions,
): Promise<UpdateCheck>;
export function checkForUpdate(
  options: ManifestClientOptions & { currentVersion: string },
): Promise<UpdateCheck>;
export async function checkForUpdate(
  currentOrOptions: string | (ManifestClientOptions & { currentVersion: string }),
  options: ManifestClientOptions = {},
): Promise<UpdateCheck> {
  const currentVersion = typeof currentOrOptions === "string" ? currentOrOptions : currentOrOptions.currentVersion;
  const clientOptions = typeof currentOrOptions === "string" ? options : currentOrOptions;
  if (!parseVersion(currentVersion)) {
    throw invalidManifest("current version must be valid semver", { version: currentVersion });
  }
  const manifest = await fetchLatestManifest(clientOptions);
  return {
    currentVersion,
    latestVersion: manifest.version,
    updateAvailable: compareVersions(manifest.version, currentVersion) > 0,
    manifest,
  };
}
