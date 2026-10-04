import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createProjectCatalog } from "./catalog/index.mjs";
import { createRemoteApiServer } from "./http.mjs";
import { loadServerRuntimeConfig, parseServerRuntimeConfig } from "./runtime-config.mjs";
import { createServerAuthStore } from "./auth/server-auth-store.mjs";
import { acquireServerServiceLock } from "./service-lock.mjs";

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
    if (error.code === "ENOENT") {
      return null;
    }
    if (error.code === "UNTRUSTED_PROJECT_METADATA") {
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

async function createMetadataFile(metadataFile, expectedProjectId) {
  try {
    const handle = await fs.open(metadataFile, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, project_id: expectedProjectId }, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function initializeProjectMetadata(metadataFile, expectedProjectId) {
  await createMetadataFile(metadataFile, expectedProjectId);
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  } catch {
    throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata could not be initialized safely");
  }
  assertMetadataIdentity(metadata, expectedProjectId, "project metadata was replaced during initialization");
}

async function ensureProjectMetadata(metadataFile, expectedProjectId, { create }) {
  const metadata = await validateMetadataFile(metadataFile);
  if (metadata) {
    assertMetadataIdentity(metadata, expectedProjectId, "project metadata does not match the trusted catalog identity");
    return;
  }
  if (!create) {
    throw runtimeError("UNKNOWN_PROJECT", "project metadata is not initialized");
  }
  await initializeProjectMetadata(metadataFile, expectedProjectId);
}

function createOpenProject({ catalog, pinnedHome }) {
  return async function openProject(projectDir, { projectId, create = false } = {}) {
    pinnedHome.assertPinned();
    const trustedDirectory = create ? await catalog.provisionProject(projectId) : await catalog.resolveProject(projectId);
    if (path.resolve(projectDir) !== trustedDirectory) {
      throw runtimeError("UNSAFE_PROJECT_STORAGE", "project opener only accepts catalog-resolved storage");
    }
    const metadataFile = path.join(trustedDirectory, ".climier.json");
    await ensureProjectMetadata(metadataFile, internalProjectId(projectId), { create });
    pinnedHome.assertPinned();
    return Object.freeze({ projectDir: trustedDirectory });
  };
}

export function createServerRuntime(rawConfig, { serverFactory = createRemoteApiServer, authStore } = {}) {
  const config = parseServerRuntimeConfig(rawConfig);
  const pinnedHome = pinStateHome(config.stateHome);
  const catalog = createProjectCatalog({ dataRoot: config.dataRoot });
  const openProject = createOpenProject({ catalog, pinnedHome });
  const server = authStore ? serverFactory({ catalog, authStore, openProject }) : null;
  return Object.freeze({ config, catalog, openProject, server, stateHome: pinnedHome.path, authStore });
}

async function preparePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
  }
}

export async function startServerRuntime(configPath, options = {}) {
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
