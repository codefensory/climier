import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProjectCatalog } from "./catalog/index.ts";
import { createRemoteApiServer } from "./http.ts";
import { loadServerRuntimeConfig, parseServerRuntimeConfig } from "./runtime-config.ts";
import { createServerAuthStore } from "./auth/server-auth-store.ts";
import { acquireServerServiceLock } from "./service-lock.ts";
import { errorProperties } from "./types.ts";

type RuntimeOptions = {
  serverFactory?: typeof createRemoteApiServer;
  authStore?: Awaited<ReturnType<typeof createServerAuthStore>>;
  acquireLock?: typeof acquireServerServiceLock;
  createAuthStore?: typeof createServerAuthStore;
  password?: string;
  now?: () => Date;
  authTestHooks?: { beforeRename?: (temporary: string, target: string) => Promise<void> };
};

const DEFAULT_UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");

function runtimeError(code, message) {
  return Object.assign(new Error(`server runtime: ${message}`), { code });
}

function internalProjectId(projectId) {
  return createHash("sha256").update(projectId, "utf8").digest("hex");
}

function pinStateHome(stateHome) {
  const resolvedHome = path.resolve(stateHome);
  process.env.CLIMIER_HOME = resolvedHome;
  const guard = () => {
    if (process.env.CLIMIER_HOME !== resolvedHome) {
      process.env.CLIMIER_HOME = resolvedHome;
    }
  };
  return Object.freeze({
    path: resolvedHome,
    assertPinned() {
      guard();
      return resolvedHome;
    },
  });
}

async function validateMetadataFile(metadataFile) {
  try {
    const metadataInfo = await fs.lstat(metadataFile);
    if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
      throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata must be a regular file");
    }
    return JSON.parse(await fs.readFile(metadataFile, "utf8"));
  } catch (error) {
    if (errorProperties(error).code === "ENOENT") {
      return null;
    }
    if (errorProperties(error).code === "UNTRUSTED_PROJECT_METADATA") {
      throw error;
    }
    throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata is corrupt or unreadable");
  }
}

function assertMetadataIdentity(metadata, expectedProjectId, message) {
  if (metadata?.version !== 1 || metadata?.project_id !== expectedProjectId) {
    throw runtimeError("UNTRUSTED_PROJECT_METADATA", message);
  }
}

async function createMetadataFile(metadataFile, expectedProjectId, sourceProjectId) {
  try {
    const handle = await fs.open(metadataFile, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, project_id: expectedProjectId, source_project_id: sourceProjectId }, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorProperties(error).code !== "EEXIST") {
      throw error;
    }
  }
}

async function initializeProjectMetadata(metadataFile, expectedProjectId, sourceProjectId) {
  await createMetadataFile(metadataFile, expectedProjectId, sourceProjectId);
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  } catch {
    throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata could not be initialized safely");
  }
  assertMetadataIdentity(metadata, expectedProjectId, "project metadata was replaced during initialization");
  if (metadata.source_project_id !== sourceProjectId) {
    throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata does not match the trusted source project identity");
  }
}

async function upgradeProjectMetadata(metadataFile, metadata, sourceProjectId) {
  const upgraded = { ...metadata, source_project_id: sourceProjectId };
  const temporaryFile = `${metadataFile}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(upgraded, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryFile, metadataFile);
}

async function ensureProjectMetadata(metadataFile, expectedProjectId, { create, sourceProjectId }) {
  const metadata = await validateMetadataFile(metadataFile);
  if (metadata) {
    assertMetadataIdentity(metadata, expectedProjectId, "project metadata does not match the trusted catalog identity");
    if (metadata.source_project_id === undefined) {
      await upgradeProjectMetadata(metadataFile, metadata, sourceProjectId);
      return;
    }
    if (metadata.source_project_id !== sourceProjectId) {
      throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata does not match the trusted source project identity");
    }
    return;
  }
  if (!create) {
    throw runtimeError("UNKNOWN_PROJECT", "project metadata is not initialized");
  }
  await initializeProjectMetadata(metadataFile, expectedProjectId, sourceProjectId);
}

function createOpenProject({ catalog, pinnedHome }: { catalog: ReturnType<typeof createProjectCatalog>; pinnedHome: ReturnType<typeof pinStateHome> }) {
  return async function openProject(projectDir: string, { projectId, create = false }: { projectId?: string; create?: boolean } = {}) {
    pinnedHome.assertPinned();
    const trustedDirectory = create ? await catalog.provisionProject(projectId as string) : await catalog.resolveProject(projectId as string);
    if (path.resolve(projectDir) !== trustedDirectory) {
      throw runtimeError("UNSAFE_PROJECT_STORAGE", "project opener only accepts catalog-resolved storage");
    }
    const metadataFile = path.join(trustedDirectory, ".climier.json");
    await ensureProjectMetadata(metadataFile, internalProjectId(projectId as string), { create, sourceProjectId: projectId as string });
    pinnedHome.assertPinned();
    return Object.freeze({ projectDir: trustedDirectory });
  };
}

export function createServerRuntime(rawConfig: unknown, { serverFactory = createRemoteApiServer, authStore }: RuntimeOptions = {}) {
  const parsedConfig = parseServerRuntimeConfig(rawConfig);
  const config = Object.freeze({ ...parsedConfig, uiRoot: parsedConfig.uiRoot ?? DEFAULT_UI_ROOT });
  const pinnedHome = pinStateHome(config.stateHome);
  const catalog = createProjectCatalog({ dataRoot: config.dataRoot });
  const openProject = createOpenProject({ catalog, pinnedHome });
  const server = authStore ? serverFactory({ catalog, authStore, openProject, uiRoot: config.uiRoot }) : null;
  return Object.freeze({ config, catalog, openProject, server, stateHome: pinnedHome.path, authStore });
}

async function preparePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
  }
}

export async function startServerRuntime(configPath: string, options: RuntimeOptions = {}) {
  const config = await loadServerRuntimeConfig(configPath);
  process.env.CLIMIER_HOME = path.resolve(config.stateHome);
  await preparePrivateDirectory(config.stateHome);
  const serviceLock = await (options.acquireLock || acquireServerServiceLock)(config.stateHome);
  let runtime;
  try {
    await preparePrivateDirectory(config.dataRoot);
    const authStore = options.authStore || await (options.createAuthStore || createServerAuthStore)({
      stateHome: config.stateHome,
      password: options.password ?? process.env.CLIMIER_SERVER_PASSWORD,
      now: options.now,
      testHooks: options.authTestHooks,
    });
    runtime = createServerRuntime(config, { ...options, authStore });
    await new Promise((resolve, reject) => {
      runtime.server.once("error", reject);
      runtime.server.listen(runtime.config.listen.port, runtime.config.listen.host, resolve);
    });
  } catch (error) {
    await serviceLock.release().catch(() => {});
    throw error;
  }
  const release = async () => { await serviceLock.release(); };
  runtime.server.once("close", () => { release().catch(() => {}); });
  return Object.freeze({ ...runtime, serviceLock });
}
