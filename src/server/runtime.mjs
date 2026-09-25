import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createProjectCatalog } from "./catalog/index.mjs";
import { createRemoteApiServer } from "./http.mjs";
import { loadServerRuntimeConfig, parseServerRuntimeConfig } from "./runtime-config.mjs";

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
    if (process.env.CLIMIER_HOME !== resolvedHome) process.env.CLIMIER_HOME = resolvedHome;
  };
  return Object.freeze({
    path: resolvedHome,
    assertPinned() {
      guard();
      return resolvedHome;
    },
  });
}

export function createServerRuntime(rawConfig, { serverFactory = createRemoteApiServer } = {}) {
  const config = parseServerRuntimeConfig(rawConfig);
  const pinnedHome = pinStateHome(config.stateHome);
  const catalog = createProjectCatalog({ dataRoot: config.dataRoot, projectIds: config.projectIds });
  const internalIds = new Map(config.projectIds.map((projectId) => [projectId, internalProjectId(projectId)]));

  async function openProject(projectDir, { projectId } = {}) {
    const expectedProjectId = internalIds.get(projectId);
    if (!expectedProjectId) throw runtimeError("UNKNOWN_PROJECT", "project is not in the trusted catalog");
    pinnedHome.assertPinned();
    const trustedDirectory = await catalog.resolveProject(projectId);
    if (path.resolve(projectDir) !== trustedDirectory) {
      throw runtimeError("UNSAFE_PROJECT_STORAGE", "project opener only accepts catalog-resolved storage");
    }
    const metadataFile = path.join(trustedDirectory, ".climier.json");
    projectDir = trustedDirectory;
    let metadata;
    try {
      const metadataInfo = await fs.lstat(metadataFile);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
        throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata must be a regular file");
      }
      metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (error.code === "UNTRUSTED_PROJECT_METADATA") throw error;
        throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata is corrupt or unreadable");
      }
    }
    if (metadata && (metadata.version !== 1 || metadata.project_id !== expectedProjectId)) {
      throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata does not match the trusted catalog identity");
    }
    if (!metadata) {
      try {
        const handle = await fs.open(metadataFile, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ version: 1, project_id: expectedProjectId }, null, 2)}\n`, "utf8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      try {
        metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
      } catch {
        throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata could not be initialized safely");
      }
      if (metadata?.version !== 1 || metadata?.project_id !== expectedProjectId) {
        throw runtimeError("UNTRUSTED_PROJECT_METADATA", "project metadata was replaced during initialization");
      }
    }
    pinnedHome.assertPinned();
    return Object.freeze({ projectDir });
  }

  const server = serverFactory({ catalog, credentials: config.credentials, openProject });
  return Object.freeze({ config, catalog, openProject, server, stateHome: pinnedHome.path });
}

export async function startServerRuntime(configPath, options = {}) {
  const config = await loadServerRuntimeConfig(configPath);
  const runtime = createServerRuntime(config, options);
  process.env.CLIMIER_HOME = runtime.stateHome;
  await fs.mkdir(runtime.stateHome, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(runtime.stateHome, 0o700);
  await fs.mkdir(runtime.config.dataRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(runtime.config.dataRoot, 0o700);
  await new Promise((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(runtime.config.listen.port, runtime.config.listen.host, resolve);
  });
  return runtime;
}
