import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function contractError(code, message) {
  return Object.assign(new Error(`server catalog: ${message}`), { code });
}

function validateProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0 || Buffer.byteLength(projectId, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(projectId)) {
    throw contractError("INVALID_PROJECT_ID", "project ID must be a non-empty bounded opaque identifier");
  }
}

function projectDirectoryName(projectId) {
  return createHash("sha256").update(projectId, "utf8").digest("hex");
}

async function ensureConfinedDirectory(dataRoot, storagePath, { create }) {
  const root = path.resolve(dataRoot);
  if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    if (error.code === "ENOENT" && !create) {
      throw contractError("UNKNOWN_PROJECT", "project is not provisioned");
    }
    throw error;
  }

  const expectedPath = path.join(rootReal, path.basename(storagePath));
  if (storagePath !== expectedPath) {
    throw contractError("UNSAFE_PROJECT_STORAGE", "catalog path is outside the configured data root");
  }

  if (create) await fs.mkdir(expectedPath, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });

  let projectReal;
  let info;
  try {
    [projectReal, info] = await Promise.all([fs.realpath(expectedPath), fs.lstat(expectedPath)]);
  } catch (error) {
    if (error.code === "ENOENT" && !create) {
      throw contractError("UNKNOWN_PROJECT", "project is not provisioned");
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || projectReal !== expectedPath) {
    throw contractError("UNSAFE_PROJECT_STORAGE", "project storage must be a real directory beneath data root");
  }
  return expectedPath;
}

export function createProjectCatalog({ dataRoot, projectIds = [] } = {}) {
  if (typeof dataRoot !== "string" || dataRoot.length === 0) {
    throw contractError("INVALID_DATA_ROOT", "dataRoot must be a non-empty path");
  }
  const configuredIds = new Set(projectIds);
  for (const projectId of configuredIds) validateProjectId(projectId);
  const rootPath = path.resolve(dataRoot);
  const storagePathFor = (projectId) => path.join(rootPath, projectDirectoryName(projectId));

  async function resolveProject(projectId) {
    validateProjectId(projectId);
    if (!configuredIds.has(projectId)) {
      throw contractError("UNKNOWN_PROJECT", "project is not in the trusted catalog");
    }
    return ensureConfinedDirectory(rootPath, storagePathFor(projectId), { create: false });
  }

  async function provisionProject(projectId) {
    validateProjectId(projectId);
    if (!configuredIds.has(projectId)) {
      throw contractError("UNKNOWN_PROJECT", "project is not in the trusted catalog");
    }
    return ensureConfinedDirectory(rootPath, storagePathFor(projectId), { create: true });
  }

  return Object.freeze({ resolveProject, provisionProject });
}

